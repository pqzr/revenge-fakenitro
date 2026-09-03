(
function (vendetta) {
    "use strict";

    const { patcher, webpack, ui } = vendetta;
    const { findByProps } = webpack;

    const PATCHED = [];
    const state = {
        emojiBypass: true,
        stickerBypass: true,
        nitroCapabilities: true,
        emojiSize: 48,
        stickerSize: 160,
        useMarkdownLinks: true
    };

    const log = (...args) => {
        try { console.log("[FakeNitro Mobile]", ...args); } catch (_) {}
    };

    const toast = (msg) => {
        try {
            if (ui && typeof ui.showToast === "function") ui.showToast(msg);
        } catch (_) {}
    };

    const getEmojiStore = () =>
        findByProps("getCustomEmojiById") ||
        findByProps("getEmojiById");

    const getStickerStore = () =>
        findByProps("getStickerById");

    const getEmojiUrl = (id, animated, size) => {
        const ext = animated ? "gif" : "png";
        return `https://cdn.discordapp.com/emojis/${id}.${ext}?size=${size}`;
    };

    const getStickerUrl = (id, formatType, size) => {
        // Discord sticker format_type: 1=PNG, 2=APNG, 3=Lottie, 4=GIF.
        const ext = formatType === 4 ? "gif" : "png";
        return `https://media.discordapp.net/stickers/${id}.${ext}?size=${size}`;
    };

    const addParams = (rawUrl, name) => {
        try {
            const u = new URL(rawUrl);
            if (name) u.searchParams.set("name", name);
            u.searchParams.set("lossless", "true");
            return u.toString();
        } catch (_) {
            return rawUrl;
        }
    };

    const linkText = (name) =>
        state.useMarkdownLinks ? `[${name || "FakeNitro"}]` : "";

    function transformEmojiSyntax(content, emojiStore) {
        if (!state.emojiBypass || typeof content !== "string") return content;

        return content.replace(/<a?:(\w+):(\d+)>/g, (full, name, id) => {
            let emoji;
            try {
                emoji = emojiStore?.getCustomEmojiById?.(id) ||
                        emojiStore?.getEmojiById?.(id);
            } catch (_) {}

            // Only transform an emoji when we can identify it as a custom emoji.
            if (!emoji && !id) return full;

            const animated = full.startsWith("<a:");
            const realName = emoji?.name || name || "FakeNitroEmoji";
            const url = addParams(getEmojiUrl(id, animated, state.emojiSize), realName);

            return state.useMarkdownLinks
                ? `${linkText(realName)}(${url})`
                : url;
        });
    }

    function transformStickerArgs(args, stickerStore) {
        if (!state.stickerBypass || !args || typeof args !== "object") return args;

        // Common mobile sendMessage shape:
        // sendMessage(channelId, message, options)
        const message = args[1];
        const options = args[2];

        if (!message || typeof message !== "object" || !options || !Array.isArray(options.stickerIds)) {
            return args;
        }

        const stickerId = options.stickerIds[0];
        if (!stickerId) return args;

        let sticker;
        try { sticker = stickerStore?.getStickerById?.(stickerId); } catch (_) {}
        if (!sticker) return args;

        // Don't touch Discord's built-in/free sticker packs.
        if (sticker.pack_id) return args;

        const formatType = sticker.format_type ?? sticker.formatType ?? 1;
        const name = sticker.name || "FakeNitroSticker";
        const url = addParams(getStickerUrl(stickerId, formatType, state.stickerSize), name);

        message.content = (message.content ? message.content + " " : "") +
            (state.useMarkdownLinks ? `${linkText(name)}(${url})` : url);

        options.stickerIds.length = 0;
        toast("FakeNitro sticker sent as a link");
        return args;
    }

    function patchMessageActions() {
        const actions =
            findByProps("sendMessage", "editMessage") ||
            findByProps("sendMessage");

        if (!actions) {
            log("MessageActions not found; emoji/sticker send bypass unavailable.");
            return;
        }

        if (typeof actions.sendMessage === "function") {
            PATCHED.push(
                patcher.before("FakeNitroMessageSend", actions, "sendMessage", (args) => {
                    try {
                        const emojiStore = getEmojiStore();
                        const stickerStore = getStickerStore();

                        if (args[1] && typeof args[1] === "object") {
                            args[1].content = transformEmojiSyntax(args[1].content, emojiStore);
                        }

                        transformStickerArgs(args, stickerStore);
                    } catch (e) {
                        log("sendMessage patch error", e);
                    }
                    return args;
                })
            );
        }

        if (typeof actions.editMessage === "function") {
            PATCHED.push(
                patcher.before("FakeNitroMessageEdit", actions, "editMessage", (args) => {
                    try {
                        const emojiStore = getEmojiStore();
                        // editMessage(channelId, messageId, message)
                        if (args[2] && typeof args[2] === "object") {
                            args[2].content = transformEmojiSyntax(args[2].content, emojiStore);
                        }
                    } catch (e) {
                        log("editMessage patch error", e);
                    }
                    return args;
                })
            );
        }
    }

    function patchNitroCapabilities() {
        if (!state.nitroCapabilities) return;

        // These names are used by Discord/Vencord's FakeNitro implementation.
        // We only patch methods that actually exist in the current Discord build.
        const names = [
            "canUseCustomStickersEverywhere",
            "canUseHighVideoUploadQuality",
            "canStreamQuality",
            "canUseClientThemes",
            "canUsePremiumAppIcons",
            "canUsePremiumProfileThemes"
        ];

        let count = 0;
        try {
            const modules = webpack.getModules?.(() => true) || [];
            for (const mod of modules) {
                if (!mod || typeof mod !== "object") continue;

                for (const name of names) {
                    if (typeof mod[name] !== "function") continue;

                    PATCHED.push(
                        patcher.instead(
                            "FakeNitroCapability:" + name,
                            mod,
                            name,
                            () => true
                        )
                    );
                    count++;
                }
            }
        } catch (e) {
            log("Capability scan failed:", e);
        }

        log("Patched capability methods:", count);
    }

    return {
        onLoad() {
            log("Loading FakeNitro Mobile");
            patchMessageActions();
            patchNitroCapabilities();
            toast("FakeNitro Mobile enabled");
        },

        onUnload() {
            for (const dispose of PATCHED.splice(0)) {
                try { if (typeof dispose === "function") dispose(); } catch (_) {}
            }
            log("FakeNitro Mobile unloaded");
        },

        settings: {
            type: "category",
            label: "FakeNitro Mobile",
            children: [
                {
                    type: "switch",
                    label: "Emoji bypass",
                    value: true,
                    onChange: (v) => { state.emojiBypass = !!v; }
                },
                {
                    type: "switch",
                    label: "Sticker bypass",
                    value: true,
                    onChange: (v) => { state.stickerBypass = !!v; }
                },
                {
                    type: "switch",
                    label: "Nitro capability bypass",
                    value: true,
                    onChange: (v) => { state.nitroCapabilities = !!v; }
                },
                {
                    type: "switch",
                    label: "Use Markdown links",
                    value: true,
                    onChange: (v) => { state.useMarkdownLinks = !!v; }
                }
            ]
        }
    };
}
)(vendetta)
