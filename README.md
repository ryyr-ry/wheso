# Wheso

Free, open-source video calling for the web. Headless by design: the SDK moves the media, your app owns the interface.

```ts
import { joinMeeting } from "@wheso/client";

const joined = await joinMeeting(location.href);
if (!joined.ok) throw new Error(joined.error.code);
joined.value.meeting.on("participantJoined", (p) => {
  const el = document.createElement("video");
  p.video.attach(el);
  stage.append(el);
});
```

Camera and microphone are requested, video starts flowing, and every participant hands you a
video sink you can place anywhere in your own layout. There is no bundled interface to fight
with, no theme to override, no markup you did not write. Failures come back as values, not
exceptions.

> **Status: pre-release.** The protocol and reference implementation are being built. The
> client SDKs are not published yet. Watch this repository for the first release.

## Why

Most video calling APIs charge per participant-minute. Wheso runs entirely on
[PartyKit](https://www.partykit.io/) Durable Objects and forwards media without transcoding,
so there is no per-minute cost to pass on. Everything is Apache-2.0 licensed and self-hostable.

## Features

- **Headless.** The SDK has no look. It gives you media, state and events; layout, controls and
  styling are yours. Audio playback and mixing stay inside the SDK, because they carry no visual
  design and splitting them breaks lip sync.
- **High quality by default.** AV1 with temporal scalability and multi-resolution simulcast. Up
  to 4K60 where the device has a hardware encoder.
- **Layout drives quality.** Tell the SDK how large you are drawing someone and it requests the
  matching layer. A thumbnail costs a thumbnail.
- **Graceful under bad networks.** Quality degrades as resolution and frame rate, not as freezes.
  Layers are dropped along the codec's dependency structure so the decoder never breaks.
- **Audio first.** Audio travels on a separate path from video and is never dropped for congestion.
- **Scales by adding nodes.** Small meetings run on a single forwarding node. Larger meetings
  shard automatically. No configuration required.
- **Identical across languages.** Every SDK runs the same decision logic, verified against frozen
  trace vectors and differential fuzzing rather than trust.
- **Nothing is recorded.** Nodes forward encoded bytes and keep none of them.
- **No lock-in.** Apache-2.0. Run it on your own PartyKit project.

## Planned SDKs

Every SDK carries the same feature set: protocol, layer selection, congestion control, AV1 and
Opus, audio mixing. Capture and rendering are outside every SDK, in every language.

| Platform | Package |
|---|---|
| Browser | `@wheso/client` |
| React | `@wheso/react` |
| Vue | `@wheso/vue` |
| Svelte | `@wheso/svelte` |
| Flutter | `wheso_client` |
| iOS | `WhesoClient` |
| Android | `dev.wheso:client-android` |
| Rust | `wheso-client` |
| C++ | header-only |

The framework packages provide reactive bindings and an unstyled video sink component. They do
not provide a themed interface.

## Getting a meeting URL

Your server creates a meeting and issues a short-lived token. The client only needs the
resulting URL.

```
https://<your-host>/j/<meetingId>#<token>
```

Tokens are valid for 60 seconds and are scoped to a single participant. Every node verifies them.

## Applications

Two first-party applications are planned alongside the SDKs, built on the same public API:

- a meeting app you use by sharing a URL, with no account,
- a persistent-room app for casual voice and video, where rooms exist whether or not anyone is in them.

They exist so the protocol is proven by products, not only by tests.

## Development

The reference implementation lives in this repository. Node 24 or newer is required.

```
npm ci
npm run ci                 # types, generated code, frozen vectors, traces, fuzzing, unit tests
npm run test:integration   # real WebSockets against a local dev server
npm run test:e2e           # real AV1 video and Opus audio through the browser (needs Chromium)
```

Language SDKs are checked against the same frozen vectors:

```
npm run test:rust
npm run test:cpp
npm run test:dart
npm run test:kotlin
npm run test:swift         # macOS
```

Constants and wire layout are generated from `spec/schema/`. Do not edit files under
`generated/` by hand; run `node tools/codegen.ts generate` instead. Test vectors in
`spec/vectors/` are frozen: if an implementation disagrees with a vector, fix the
implementation.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
