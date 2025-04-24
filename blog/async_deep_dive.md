---
layout: post
title:  "A deep dive into networking and memory"
date:   2025-04-24 12:59:10 -0400
categories: jekyll update
permalink: /blog/async_deep_dive
---

# Introduction
Kulve has been a massive learning experience into the innerworkings of threading, async, and blending them together. In this post I'm going to go into a bit of a deep dive into how Kulve is able to asyncronously and efficiently request data across multiple APIs while also keeping the data scoped, linked, and managed without any duplicate or unnecessary allocations. This "handler" component (still don't know what to name it) also orchestrates the asyncronous workflow in a way that not only doesn't wait for results, but ensures that no data races occur if the UI ends up navigating away from the page and/or starts a new request before the results of the first one.

# Kulve's network handler and allocator
The `handler` is a C++ generic that handles bulk network requests that both span and link data across multiple Twitch APIs. The interface to it looks like this:

```cpp
constexpr size_t bucket_size  = 100;
constexpr size_t sets_to_keep = 2;

using SearchedChannelHandler  = GenericHandler<
     searched_channel,
     bucket_size,
     sets_to_keep,
     twitch_user,
     twitch_stream>;
using StreamHandler =
    GenericHandler<twitch_stream, bucket_size, sets_to_keep, twitch_user>;
using VodHandler  = GenericHandler<vod, bucket_size, sets_to_keep, twitch_user>;
using ClipHandler = GenericHandler<clip, bucket_size, sets_to_keep, Game, twitch_user>;
using CategoryHandler     = GenericHandler<TwitchCategory, bucket_size, sets_to_keep>;
```

Simply put, you define (you don't have to, but I think it's easier to work with) the specific blueprint for the data you need to work with.

- `bucket_size` is the number of items that should be queried and held onto. Since the Twitch API allows you to request up to 100 items at once, that's the default size.
- `sets_to_keep` is used to specify the number of buckets to keep in scope before overwriting. This is important because the memory in the backend can be deallocated faster than the UI can update, meaning you invalidate the UI data before it's detected that it no longer needs to be displaying those items. This causes an immediate crash as the UI will encounter `nullptr`.
- The types after `sets_to_keep` are the additional types that need to be linked to the front facing type.

## How Kulve spans across multiple APIs

The handler itself looks like this:
```cpp
template <typename helix_type, size_t size, size_t sets_to_keep, typename... LinkedTypes>
class GenericHandler {
public:
    using item_array = array<helix_type *, size>;
    using handler_t  = GenericHandler<helix_type, size, sets_to_keep, LinkedTypes...>;
    using callback_t = std::function<int(void *context)>;

    static inline handler_t *getHandler() {
        return new handler_t;
    }

    static inline void deleteHandler(handler_t *handler) {
        delete handler;
    }
```
The breakdown is that you define the front facing type you're requesting. To keep it simple, we'll use a `twitch_stream` as an example. A `twitch_stream` has just one single linked type: `twitch_user`. The reason for this link is that the profile image of a stream is actually a part of the user, not the stream. So in order to show the profile picture of a stream, you need to get the user information for it.

Kulve is able to make this work by heavily leveraging asyncronous networking as outlined below.

### 1. Front facing entry point function
In the case of the `StreamHandler`, it utilizes this function:
```cpp
    void getStream(const std::string &user_login) {
        boost::url url{http::twitchBaseUrl};
        url.set_path("/helix/streams");
        url.set_params({"user_login", user_login});

        this->_get_items(url);
    }
```

Every single entrypoint function looks exactly like this. Takes in whatever specific query parameters are needed, defines the url, then passes that information to the function that starts the workload.

### 2. Create and prepare the asyncronous job
```cpp
    void _get_items(boost::url_view url, header_type type = header_type::twitch_headers) {
        this->_prepare_for_reuse();
        /**
         * Kulve's in-house http client
         */
        auto c                          = http::make_client(this->_ioc);
        std::shared_ptr<struct job> job = std::make_shared<struct job>();
        job->id                         = this->_job_id;

        /**
         * establish the completion handler for the request
         */
        c->prepare_get(url, [this, job](std::string_view response, int status_code) {
            json j(response);
            this->_parse_items(j.get(), job);
            this->_set_pagination(j.get());
        });

        c->add_auth_headers();
        c->run();

        /**
         * block the thread and execute the work
         */
        this->_ioc.run();
    }
```
This code kicks off the network request by defining a `job`, which is simply a struct that stores the data for the request so that it's decoupled from the handler itself. It also contains an id to ensure that the current job is still valid. This way, if the user navigates away from the UI that's making the request, the async workload doesn't return from the network request and try to check for data that's no longer valid. The `job` ensures that the temporary data is still valid, but this will be demonstrated in a bit.

`c->prepare_get()` prepares the request defined in the `url` and passes in the function to be executed when the request is complete. In this case, it will call `this->_parse_items()` with the data from the request to begin preparing the linked types.

### 3. Begin preparing the linked types for spanning across APIs
`_parse_items()` looks like this:
```cpp
    void _parse_items(dom::element json, std::shared_ptr<struct job> job) {
        query_container query_container;
        for (size_t i = 0; i < this->_num_linked; i++) {
            query_container.push_back(handler::query_array());
        }
        for (auto i : json["data"]) {
            job->ind         = 0;
            /**
             * for each entry in the json array, create an
             * actual data type.
             * in this example this would be creating a
             * twich_stream object.
             *
             * every data type in Kulve is constructible from json,
             * so this returns a fully populated object.
             */
            helix_type *item = new helix_type(i);
            job->items.push_back(item);
            /**
             * this function call iterates over the LinkedTypes passed
             * in the handler's template arguments
             * and calls the _prepare_linked_types()
             * function for that specific LinkedType.
             */
            (this->_prepare_linked_types<LinkedTypes>(query_container, item, job), ...);
        }
        job->ind = 0;
        /**
         * if there's no linked type or items, then there's no reason to execute the requests for the linked items.
         */
        if (job->items.length() > 0 && this->_num_linked > 0) {
            (this->_get_linked_types<LinkedTypes>(query_container, job), ...);
        }
        /**
         * if there's no work to do, post the job as complete.
         */
        if (this->_num_linked == 0 || this->items.length() == 0) {
            this->_post(job);
        }
    }
```
There's a lot of complexity here, but the general idea is that the json from the initial request is iterated and the front facing objects, which in this case would be `twitch_stream` objects, are populated from the json entry and added to the job's `item` array, which is a static array that matches the bucket size to ensure it can store everthing it needs to.

From here, the linked types get prepared.

### 3. Preparing the linked types
```cpp
    template <typename LinkedType>
    void _prepare_linked_types(
        query_container &arr,
        helix_type *item,
        std::shared_ptr<struct job> job
    ) {
        /**
         * check for existing linked type entry
         */
        auto &map = job->linked_maps[job->ind];
        auto got  = map.find(item->linked_field(job->ind));

        /**
         * create new entry if item not in map
         */
        if (got != map.end()) {
            item->set_linked_data(got->second, job->ind);
        } else {
            this->_create_new_linked_entry<LinkedType>(arr, item, job);
        }
        job->ind++;
    }
```
This is where things start to get really interesting. Kulve **does not** process or request duplicate information. So for example, if the front facing object type is a `clip`, then it's totally possible that there's 100 clips for a single stream. In this case, it'll iterate the first clip, allocate a `twitch_stream` object, and store it into a map to be populated later on by a network request. Once it moves to the next clip, it'll check the `linked_map` for the stream, see that it's already been populated, and move on. This allows all 100 clips to share the same exact, single instance of a stream. Otherwise Kulve would be allocating 100x the memory it currently does (and there's absolutely no need for that).

The call to `item->set_linked_data()` is a call to the front facing object itself. Every object in Kulve opts into this handler by defining a function that tells the handler how it should link. Here's what the function looks like for a `twitch_stream`:
```cpp
    void set_linked_data(void *data, int ind) {
        switch (ind) {
        default:
            this->user = static_cast<twitch_user *>(data);
            break;
        }
    }
```
You'll notice the switch statement. In this case, there's only a default case because a `twitch_stream` only links to one single item: a `twitch_user`. So when the `set_linked_data()` function gets called for a `twitch_stream`, it simply assigns the pointer to the `twitch_user *user` attribute of the object.

The way I picture this is that it's setting a symlink to the user object within the stream. And keep in mind that this user may or may not be unique, but since the `twitch_stream` isn't the owner of the data, it doesn't matter. The handler itself is what handles the allocation, storage, and deallocation, so it's not an issue to share a single pointer across potentially 100s of items. The items don't control the lifetime, just allow access to it.

### 4. Execute the linked network requests
```cpp
    template <typename LinkedType>
    void _get_linked_types(query_container &arr, std::shared_ptr<struct job> job) {
        int cur_ind = job->ind;
        arr[cur_ind].push_back(helix_type::linked_key(cur_ind));
        if (arr[cur_ind].length() > 1) {
            LinkedType::get_bulk_data(
                arr[job->ind],
                this->_ioc,
                [this, cur_ind, job](dom::element json) {
                    if (this->_job_id != job->id) {
                        /**
                         * maybe delete job from _post? xcode doesn't report
                         * leaks, but this definitely should leak, right?
                         */
                        this->_post(job);
                        return;
                    }
                    const char *linked_key = helix_type::linked_key(cur_ind);
                    auto &map              = job->linked_maps[cur_ind];
                    for (auto i : json["data"]) {
                        /**
                         * use linked_key from main type which tells what key to
                         * grab from the Twitch json.
                         */
                        const char *data = i[linked_key].get_c_str();
                        LinkedType *l    = static_cast<LinkedType *>(map[data]);
                        if (l) {
                            /**
                             * only current job will have non-null data
                             */
                            l->set_data(i);
                        }
                    }
                    /**
                     * this needs to ensure that each iteration of
                     * linked_item is processed.
                     */
                    job->linked_processed++;
                    this->_post(job);
                }
            );
        }
        job->ind++;
    }
```
This monstrosity is what actually does the fetching of the linked data across multiple APIs. This function gets called for each `LinkedType` that was passed into the handler's generic parameters, so it's going to execute requests for each of those types which are going to have unique endpoints. These endpoints are defined in the type itself and is accessed by the `LinkedType::get_bulk_data()` static function. Here's what it looks like for a `twitch_user`:
```cpp
void twitch_user::get_bulk_data(
    handler::query_array &user_ids,
    asio::io_context &ioc,
    completion_handler handler
) {
    boost::url url{http::twitchBaseUrl};
    url.set_path("/helix/users");
    size_t ind = 0;

    for (const auto &i : user_ids) {
        if (ind == user_ids.length() - 1) {
            break;
        }
        url.params().append({user_ids.back(), i});
        ind++;
    }

    twitch_user::_user_request(url, ioc, handler);
}
```

In essence, it takes the array of user_ids, appends them to the query parameters, and executes the request:

```cpp
void twitch_user::_user_request(
    boost::url_view url,
    asio::io_context &ioc,
    twitch_user::completion_handler callback
) {
    auto c = http::make_client(ioc);
    c->prepare_get(url, [callback](std::string_view response, int status_code) {
        json j(response);
        callback(j.get());
    });
    c->add_twitch_headers();
    c->run();
}
```
Since everything is fully asyncronous, every single one of these functions returns immediately. The pattern of `c->prepare_get()` is what defines the callback to be executed once the network results are ready, and the `c->run()` call is what schedules the execution, but it does not actaully do the execution. If you recall at the beginning, the thread's blocking and execution is handled by the call to `this->_ioc.run();`.

This handler is able to facilitate memory management, networking, and thread management without actually waiting for results, which keeps the UI incredibly performant and efficient. It also keeps resource usage as low as possible, as it's able to execute a whole lot of network requests on a single thread without issue.

The use of the `job` struct to ensure that the async work doesn't return and access invalid data is what allows Kulve to keep the UI responsive regardless of the state of the networking code.

The network results can be thrown out and ignored at any point because the memory of the job itself is decoupled from the memory of the handler. Before the `job` struct, I would end up with race conditions where the handler would begin executing a new request, which empties out the maps and changes their contents, but the old network request was still in flight. When that old request's completion handlers get called, they'd try to access the memory that has since been deallocated which would cause a crash.

### 5. Managing the memory
Kulve uses a custom allocator (or data store? memory manager? really don't know what to call it) called `kv_allocator`.
```cpp
template <
    typename helix_type,
    size_t size,
    size_t sets_to_keep,
    typename map_type,
    typename... LinkedTypes>
class kv_allocator {
public:
    using item_array = array<helix_type *, size>;
    using linked_map = linked_map_handler<map_type, LinkedTypes...>;

    kv_allocator<helix_type, size, sets_to_keep, map_type, LinkedTypes...>() {}

    ~kv_allocator<helix_type, size, sets_to_keep, map_type, LinkedTypes...>() {
        for (int i = 0; i < this->_data_sets.capacity(); i++) {
            this->_data_sets[i].free();
        }
    }

    void add_items(item_array &items, linked_map &map) {
        if (this->_total_sets == this->_data_sets.capacity()) {
            this->_set_delete();
        }
        this->_append_set(items, map);
    }
    ...
```

This allocator is configured with the params that the network handler is configured with. As you can see in `add_items`, it will check whether the current sets in memory match the max capacity (aka `sets_to_keep`), and if so, deallocate the oldest set and replace it with the current new set. This is necessary because the backend can invalidate memory faster than the UI can detect that it no longer needs it. Keeping at least one backup of the data ensures that the UI doesn't ever encounter `nullptr`.

The allocator is interfaced with when a job is completed and posted, which happens here within the handler itself:
```cpp
    void _post(std::shared_ptr<struct job> job) {
        if (this->_job_id == job->id) {
            if (job->items.length() == 0) {
                this->items = job->items;
                this->_garbage.add_items(job->items, job->linked_maps);
                this->_callback(this->_context);
                return;
            }
            if (job->linked_processed == this->_num_linked) {
                this->items = job->items;
                this->_garbage.add_items(job->items, job->linked_maps);
                this->_callback(this->_context);
            }
        }
    }
```
The allocator in code is called `_garbage` because I originally considered it a garbage collector, but I don't think that's an accurate term, since it's not exactly collecting data and doing a bulk free at specified intervals, but more efficiently working with a specifically defined static container of data sets. But for now, it's named `_garbage` in the code.

# Conclusion
I hope you enjoyed this breakdown of a component of Kulve that I'm very proud of. This architecture was a lot of trial, error, and frustration, but the payout was well worth it. If you use Kulve after reading this post, try loading up the clips of a stream and think about how the code described in this post is what powered it. All of the clips in the UI are the result of the `ClipHandler`, so it would be a total of 3 APIs being accessed asyncronously and linked together.

If you have any comments, questions, feedback, or just otherwise want to know more, don't hesitate to join the Kulve [Discord](https://discord.gg/55T4AKJKt3) and reach out!

<h3>
<a href="/blog/tech_stack">Previous post</a>
</h3>
