---
layout: post
title:  "Kulve's SwiftUI runtime"
date:   2025-05-17 12:59:10 -0400
categories: jekyll update
permalink: /blog/swiftui_runtime
---

# Introduction
I wrote a crossplatform, multithreaded, fully async runtime for SwiftUI to power Kulve. It's written in C++ with minor Objective-C scaffolding to handle the runloop notifications via NotificationCenter.

# Why?
The short answer: it was an accident.

The long answer: performance.

One of the goals of Kulve is to offer the most performant Twitch experience humanly possible. I wanted it to be lightweight, fast, and most importantly, efficient. I wanted to be able to watch Twitch for more than 2-4 hours and keep it more in line with the excellent battery life of Apple silicon.

I say it was an accident because I didn’t originally set out to write a custom runtime. I wasn't thinking about managing threads manually, or handling memory myself. But as the app grew and the demands on the UI increased, those decisions started making themselves. Bit by bit, C++ crept in as the most viable solution to bypass SwiftUI's constraints and reach the level of control the app needed.

In terms of performance, there were 3 basic steps to optimizing the UI:

# Step 1: Eliminate all copies
The most significant performance cost, bar none, is copying data. Think of it this way: if the UI holds 150 messages at max (the backend holds 2.5k), when a new message comes in, the UI needs to redraw the chat. The redraw process involves recreating every single message currently on screen. If you are in a chat like xqc or KaiCenat, that can be a ton of messages flying in at once.

If you are copying the messages on every UI update, you would be dealing with exponentially more data. Instead of one new message every time, it'd be 150, since a copy is allocating an entirely new object for the data you already had. SwiftUI would go through your data source, an array of 150 items, and it would copy the messages, one by one, into another array. No algorithm is saving you from that kind of cost. At the scale of the busiest Twitch chats, it's just flat out unviable. The only thing you can do in that situation is to figure out why the data is getting copied and stop it from happening.

# Step 2: Figure out how to manage only one instance of all data
Eliminating copies comes with complexity. Without copies, the UI isn't the owner of its own data. This means that you're exposing yourself to `nullptr`, possible race conditions, etc. These are complex and, to be quite frank, annoying problems to solve. That being said, they're certainly solvable. In this post I'll focus on how Kulve manages the threads specifically.

In fact, here's the threading component Kulve uses:
```cpp
#ifndef RUNTIME_H
#define RUNTIME_H

#include <kulve/Chat/chat.h>
#include <kulve/array.hpp>
#include <kulve/channel_handler.hpp>
#include <kulve/data/twitch_stream.h>
#include <kulve/kv_runtime/kv_thread.hpp>
#include <kulve/stream_handler.hpp>

namespace kv {

constexpr size_t bucket_size  = 100;
constexpr size_t sets_to_keep = 2;

template <typename key_t>
class kv_runtime {
public:
    kv_runtime() {}

    ~kv_runtime() {}

    kv_runtime(const kv_runtime &r) = delete;

    template <typename driver_t>
    void start_chat(const key_t &notif_str, const std::string &user_login) {
        driver_t *driver = driver_t::get(notif_str, user_login);
        this->_add_driver(driver, notif_str);
        this->_add_thread<driver_t>(driver, notif_str);
    }

    template <typename driver_t>
    void get_stream(const key_t &key, const std::string &user_login) {
        stream_handler<key_t> *driver = this->_get_or_create_driver<driver_t>(key);
        driver->populate(key, user_login);
        this->_add_thread<driver_t>(driver);
    }

    template <typename driver_t>
    void get_channel(const key_t &key, const std::string &broadcaster_id) {
        driver_t *driver = this->_get_or_create_driver<driver_t>(key);
        driver->populate(key, broadcaster_id);
        this->_add_thread<driver_t>(driver);
    }

    template <typename driver_t>
    inline void send_chat(
        const key_t &key,
        const std::string &message,
        const std::string &reply_parent_id
    ) {
        driver_t *d = this->_get_driver<driver_t>(key);
        d->async_send_message(message, reply_parent_id);
    }

    template <typename driver_t>
    void stop(const key_t &key) {
        kv_thread<driver_t> *t = this->_get_thread<driver_t>(key);
        t->stop();
        t->join();
    }

    template <typename driver_t>
    inline void delete_thread(const key_t &key, bool delete_driver = true) {
        driver_t *driver       = this->_get_driver<driver_t>(key);
        kv_thread<driver_t> *t = this->_get_thread<driver_t>(key);
        delete t;
        this->_thread_map.erase(static_cast<void *>(driver));
        if (delete_driver) {
            delete driver;
            this->_driver_map.erase(key);
        }
    }

    template <typename driver_t>
    inline void join(const key_t &key) {
        this->_get_thread<driver_t>(key)->join();
    }

private:
    template <typename driver_t>
    inline driver_t *_get_driver(const key_t &key) {
        return static_cast<driver_t *>(this->_driver_map[key]);
    }

    template <typename driver_t>
    inline driver_t *_get_or_create_driver(const key_t &key) {
        driver_t *driver;
        auto got = this->_driver_map.find(key);
        if (got == this->_driver_map.end()) {
            driver = driver_t::getHandler();
            this->_add_driver(driver, key);
        } else {
            driver = static_cast<driver_t *>(got->second);
        }
        return driver;
    }

    template <typename driver_t>
    inline kv_thread<driver_t> *_get_thread(const key_t &key) {
        void *d = this->_driver_map[key];
        return static_cast<kv_thread<driver_t> *>(this->_thread_map[d]);
    }

    template <typename driver_t>
    inline void _add_thread(driver_t *driver, const key_t &key) {
        this->_thread_map[static_cast<void *>(driver)] = new kv_thread<driver_t>(driver);
    }

    template <typename driver_t>
    inline void _add_thread(driver_t *driver) {
        this->_thread_map[static_cast<void *>(driver)] = new kv_thread<driver_t>(driver);
    }

    template <typename driver_t>
    inline void _add_driver(driver_t *driver, const key_t &key) {
        this->_driver_map[key] = static_cast<void *>(driver);
    }

    /**
     * map a driver_t to a thread
     * <driver_t *, kv_thread<driver_t *>
     */
    using thread_map_t = std::unordered_map<void *, void *>;
    /**
     * map a key_t (UUID) to a driver_t
     * <key_t, driver_t *>
     */
    using driver_map_t = std::unordered_map<key_t, void *>;

    thread_map_t _thread_map;
    driver_map_t _driver_map;
};

} // namespace kv

#endif /* RUNTIME_H */
```

I want to address the use of `void *` here. `void *` is a solid solution to a very important constraint:

### I need to be able to store all of the app's data in a single object.

(The short answer of why this is a requirement is that it's very tricky to own large amounts of data in Swift in a way that guarantees expected lifetimes and portability.)

Without `void *`, I would have to use either `std::any` or `std::variant`. Both are fine solutions, but `std::variant` would require me to list any an all possible types and use `std::get_if()` to extract the types. `std::any` would be effectively the exact same thing as `void *` except with additional runtime cost. In the end, I don't think I would have changed the basic design. The calling code is responsible for providing the type it's expecting to work with which keeps the `void *` casts consistent, safe, and reliable. By using `void *`, I get the benefit of both less boilerplate and no runtime checks (additional cost) on anything.

Aside from type erasure, `void *` also allows me to use the memory address of the driver itself as the key to the thread that's currently running it. Using the memory address as a key is perfect, because it's both numerical and guaranteed to be unique. It's effectively the perfect UUID except it's efficient to store, lookup, and hash. It's directly mapping memory to memory.

# Step 3: Figure out how to connect this to SwiftUI
The secret sauce of this design is `NotificationCenter`. `NotificationCenter`, to me, is genius. To put it into perspective, `NotificationCenter` is like hitting an API with json data except it's not over the network, not json data, and can both send and receive `void *` pointers. As you can see, our dear friend `void *` is already back. The UI, via OS notifications, has a direct line, with 0 abstraction layers, into the raw depths of the runtime's memory. With Swift's C++ interop, I can safely cast that raw `void *` pointer into a typed pointer in Swift which is then used directly in the UI. No copies needed.

The notifications look like this:
```objc
- (void)handleNotification:(NSNotification *)notification {
    NSLog(
        @"received notification on thread: %@, info: %@",
        [NSThread currentThread],
        notification.userInfo
    );

    NSNumber *n             = notification.userInfo[@"type"];
    KVNotificationType type = (KVNotificationType)[n integerValue];
    const std::string &id   = [notification.userInfo[@"id"] UTF8String];

    switch (type) {
    case startChat:
        self.runtime->start_chat<chat::ChatDriver>(
            id, [notification.userInfo[@"user_login"] UTF8String]
        );
        break;
    ...
    }
```

Every UI element in Kulve can both instruct and listen to the runtime without touching it directly. When Kulve boots up, a thread is spawned that runs an `NSRunLoop`. An `NSNotification` subscription is created and the runtime is able to spawn any and all threads/async work the UI needs. It will emit a notification with the same name as the ID of the view that sent the work request in the first place. It will embed any relevant metadata straight into the notification itself via `NSDictionary` (my json replacement) and the UI will update.

One huge W from decoupling the runtime with the frontend like this is that I get complete and total control over lifetimes. In SwiftUI, views run their `body` funcs in background threads (or at least they do sometimes. Who knows.). The issue here is that since I'm not letting the UI own copies of the data, I can end up in situations where the source of the data is already gone, but a view hasn't finished with its `body`. This causes a `nullptr` dereference and a crash. This is not a good spot to be in because you don't have any control over when views will really be done with the data, and you can't have each individual view own the data source. To solve this, I can simply defer deallocation. When I'm done with the front end data source, I emit a notification that fires off 1 second later (because surely SwiftUI is finished 1 second later). This notification will get picked up by the backend and deallocate the memory associated with whatever UI sent it and will clear the entry in the map.

As of right now, this runtime is included in the most recently submitted update to the AppStore. I'm excited to see how it does once approved.

PS: If you're curious for more details on how this is built or want to dig into any part of the system, feel free to reach out—I'd love to chat.

<a href="https://discord.gg/55T4AKJKt3" class="discord-button">
    <img src="img/discord_logo.png" alt="Discord logo" />
    Join the Kulve Discord
</a>

<a href="https://apps.apple.com/us/app/kulve/id6476389316?mt=12">
    <img src="/img/download_appstore.svg" alt="Download on the App Store" class="download-button" />
</a>
