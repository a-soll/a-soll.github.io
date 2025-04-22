<div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
  <img src="img/cpp_logo.png" alt="cpp logo" width="100"/>
  <span style="font-size: 75px;">🤝</span>
  <img src="img/swift_logo.png" alt="swift logo" width="100"/>
</div>

# Introduction
I figure the tech stack of Kulve is unique enough to be interesting, so seems like a good place to start for my first blog post. Kulve is a SwiftUI application that heavily leverages the Swift/C++ interop that got introducted with Swift 5.9. While it's not perfect, it offers just enough to be able to reliably blend the two languages together.

# The stack itself
- CMake
- Xcode
- VSCode
- Swift/SwiftUI
- C++

**CMake** is used to develop the C++ backend independently from the app itself. I find I really don't like Xcode as a general editor, so it was well worth the effort to configure the backend as a standalone C++ project leveraging CMake. The app itself compiles the C++ via Xcode, but when testing, running, and developing the backend itself, it's done via CMake in VSCode. The added benefit here is that Kulve's entire backend remains completely and entirely cross platform. Meaning that if I want to port this to Windows, the backend won't have to be modified in any way to do so. This is one of the key reasons Kulve is both native and cross platform.

**Xcode** is used out of sheer necessity. It's a first class SwiftUI editor and a truly great build system. It's less ergonomic than VSCode in terms of raw editing, but I've been incredibly happy with it as a build and deploy platform. My builds are single button presses that compile and run near instantly. Fresh builds can take a few minutes, but when I need to compile and run the app for testing, it really couldn't be any faster.

**VSCode** is used for backend development. The [clangd](https://marketplace.visualstudio.com/items/?itemName=llvm-vs-code-extensions.vscode-clangd) extension is an incredibly C++ editing experience and it has out of the box compatibility with Cmake. All I need to do is add `set(CMAKE_EXPORT_COMPILE_COMMANDS ON)` to the backend's `CMakeLists.txt` and the extension configures itself directly from the `build/` dir. The clangd extension is also the fastest linter I've yet to use on VSCode. I even prefer it to Xcode's auto complete/linting experience.

**Swift** is used purely for UI and for some scaffolding for the UI. I don't use Swift as a general purpose language in this app. For anything general purpose or outside the scope of rendering to the screen, it's handled in C++.

**C++** is the bread and butter of this app. It handles the threading, asyncronous networking, and the runtime (memory allocation, websocket event loop, deallocation, etc). [boost](https://github.com/boostorg/boost) is used extensively for the networking and I've been very happy with its flexibility and performance. The learning curve was incredibly high and it took a few weeks if not months to even get off the ground with it, but now that it's clicked, I can't imagine ever going back from the networking library that's been written for Kulve.

# Swift/C++ interop
I want to demonstrate how Kulve leverages the interop by briefly describing how the chat works.

```swift
struct ChatView: View {
    @EnvironmentObject var emitter: UIMessageEmitter
    ...
}
```
The chat relies on a `UIMessageEmitter` to supply it with updates. If you're familiar with SwiftUI then you know that it works by subscribing to `ObservableObjects` and will update whenever the `@Published` property of that object changes. In this case, the `UIMessageEmitter` populates an array of messages, but the UI doesn't update until the `newMessage` boolean is toggled. This allows for more precise control over when the UI should actually update without pausing the actual collection of new message data (like when you're hovered over chat and I don't want the chat's `List` to update while you're scrolling, but still need to ensure I'm not skipping any messages).

```swift
class UIMessageEmitter: ObservableObject {
    var messages: [UIMessage] = []
    @Published var newMessage = false
    private var sub: AnyCancellable!
    @Published var messagesBelow = 0
    /**
    ChatHandler is just a convenient alias to the runtime:
    using ChatHandler = kv::kv_runtime<chat::ChatDriver>;
    */
    var chat = kv.ChatHandler() // C++ driver for the chat thread itself
    var threadID: Int?          // ID of the chat thread so the UI can still manage it
    var notifID: UUID!          // unique ID to register notifications to so multiple chats
                                // can be ran at once
    var user_login: std.string = ""
    ...

    func startChat(user_login: std.string, notifID: UUID) {
        self.user_login = user_login
        self.notifID = notifID
        self.loopChat()
    }

    private func loopChat() {
        self._removeObserver()
        self._addSubscriptions()
        self.messages.removeAll()
        self.paused_array.removeAll()
        self.threadID = chat.start_chat(std.string(self.notifID.uuidString), self.user_login)
    }

    func stop() {
        self.messages.removeAll()
        self.chat.stop(self.threadID!)
    }
}
```

The way this links together is that the chat calls into the backend to start the chat thread. All the backend needs is the unique UUID and the login of the chat to connect to. From here, it'll spawn a thread and return just an integer so that the UI can stop the thread or issue commands into it. The backend part looks like this:

```cpp
template <typename driver_t>
class kv_runtime {
public:
    kv_runtime() {}

    size_t start_chat(const std::string &notif_str, const std::string &user_login) {
        size_t key             = this->_key;
        driver_t *proc         = driver_t::get(notif_str, user_login);
        this->_thread_map[key] = new kv_thread<driver_t>(key, proc);
        this->_key++;
        return key;
    }

    void stop(size_t key) {
        kv_thread<driver_t> *thread = this->_thread_map[key];
        thread->stop();
        thread->join();
        delete thread;
    }
    ...
}
```

Without getting too much into the specifics of how the chat driver works, this is the basic premise:

```cpp
void ChatDriver::_privmsg_handler(std::string_view message) {
    if (message[0] == '@' && this->_badge_handler.isComplete()) {

        if (this->_lightBg) {
            this->_lightBg = false;
        } else {
            this->_lightBg = true;
        }
        int ind = this->_header.parse(message);
        this->_message.parse(ind, message);
        bool is_mention         = false;
        ui::UIChatMessage *ui_m = new ui::UIChatMessage(
            this->_container.tokenize(this->_message, is_mention),
            this->_badge_handler.getBadges(this->_header.badges),
            this->_header.display_name,
            this->_header.color,
            this->_lightBg
        );
        ui_m->is_mention = is_mention;
        /**
         * store the message memory to ensure there's
         * always access to it and no leaks occur.
         */
        this->_ui_messages.write_back(ui_m);
        /**
         * emits the notification to call the completion
         * handler of the UIMessageEmitter.
         */
        send_notif(this->_notif_str.c_str(), static_cast<void *>(ui_m));
    }
}
```

When a new message has been processed, the `_privmsg_handler` function is called. This function attaches the raw message data to the notification by casting it to `void *`. This isn't an issue because the Swift frontend knows about the `UIChatMessage` type, so it's no problem to cast it back from `void *` so that the data can be used. The chat driver will also store the pointer in a static container so that the message never gets lost (aka, memory leak).

Oh yeah, it even gets the benefit of automatic memory management via deconstructors:

```cpp
    ~ChatDriver() {
        this->_ioc.stop();
        this->_stopped = true;
        this->_ui_messages.free();
    };
```

When the chat driver goes out of scope, all memory is automatically freed. This is one of the major reasons C++ is viable at such large scale. The language's object design can be exploited to ensure that memory is tied to a specific lifetime and that there are no possibilities for leaks to occur.

# Memory management and ownership
C++ is the source of truth for all of the app's data. This is crucial because Swift isn't great at dealing with raw memory, but raw memory is a necessary evil for a performant application. The way Kulve ensures safety on the Swift side when accounting for raw pointers is by wrapping the raw pointers in a Swift object (objects in Swift are passed by reference and not copied, so this works out great). Here's what the Swift wrapper for a chat message is:

```swift
class UIMessage: Identifiable, Hashable {
    let id = UUID()
    let item: UnsafeMutableRawPointer

    init(item: UnsafeMutableRawPointer) {
        self.item = item
    }

    public func hash(into hasher: inout Hasher) {
        return hasher.combine(id)
    }

    public static func == (lhs: UIMessage, rhs: UIMessage) -> Bool {
        return lhs.id == rhs.id
    }
}
```

It's incredibly simple, but incredibly powerful. This barebones object allows me to:
1. Manage raw pointers directly in SwiftUI by assigning an ID that is both hashable and equatable.
2. Give a type to what's essentially a `void *` pointer. I don't treat the item as a pointer until I need to access data from it. Until then, it's dealt with as a `UIMessage`.

This wrapper means that the `List` for the chat is able to securely and efficiently manage updates by being able to tell whether something is unique or not. Without this, the UI would be incredibly inefficient. There would be absolutely no way to tell whether the underlying data of the chat has changed, what changed, and why.

It also keeps Swift from owning any of the memory. If a `UIMessage` gets deallocated, the actual data of the `item`, aka the raw pointer, is still in scope, stored nicely in the backend's container. Because UI can be incredibly tricky when it comes to ensuring scope, it works best to not allow it to claim ownership of anything. It also means that if the UI does decide to copy anything, it would be copying an 8 byte pointer. This allows me to do things like embed entire databases into chat messages, since those databases are basically symlinked via an 8 byte pointer.

To access the data of the pointer in the UI, it's not exactly ergonomic, but it works like this:

```swift
struct MessageView: View {
    @State var chat: UIMessage
    @State var id = UUID()
    @State var hoveredEmote = ""
    @State var color: Color

    var body: some View {
        let chat = self.chat.item.assumingMemoryBound(to: kv.UIChatMessage.self)
        ...
    }
    ...
}
```

It's just an overly complex way to do `static_cast<UIChatMessage *>(self.chat.item)`, but it does work well and ensures that I am never copying that data when the UI updates and needs to access it. Without raw pointers like this, the UI would be copying the underlying data every single time it redraws which would be an immense performance cost, and one that the app had before it settled on this design.

# Conclusion
I hope you enjoyed reading a little bit about how a native Twitch application works internally. I have so much more to talk about with the app, especially now that I've started porting it to iOS. There are a ton of unique problems Kulve has had to sovle that I wasn't able to find solutions for anywhere online, so I'm hoping that these posts end up being both informative and helpful for anybody else who's interested in native SwiftUI development.

If you have any comments, questions, feedback, or just otherwise want to know more, don't hesitate to join the Kulve [Discord](https://discord.gg/55T4AKJKt3) and reach out!
