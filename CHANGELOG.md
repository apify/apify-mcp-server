# Changelog

All notable changes to this project will be documented in this file.

## [0.4.7](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.7) (2025-09-09)

### 🚀 Features

- Improve actor tool output ([#260](https://github.com/apify/apify-mcp-server/pull/260)) ([7ef726d](https://github.com/apify/apify-mcp-server/commit/7ef726d59c49355dc5caa48def838a0f5ebf97c8)) by [@MQ37](https://github.com/MQ37)

### 🐛 Bug Fixes

- Error when content type is json ([#265](https://github.com/apify/apify-mcp-server/pull/265)) ([279293f](https://github.com/apify/apify-mcp-server/commit/279293f2ee0ca7ddf1bb935b1c6135747e79ede3)) by [@MichalKalita](https://github.com/MichalKalita), closes [#264](https://github.com/apify/apify-mcp-server/issues/264)


## [0.4.5](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.5) (2025-09-04)

### 🚀 Features

- Cancellable Actor run ([#228](https://github.com/apify/apify-mcp-server/pull/228)) ([9fc9094](https://github.com/apify/apify-mcp-server/commit/9fc9094f65c5ac70ec8f3d8d6a43ac7839b34cb1)) by [@MichalKalita](https://github.com/MichalKalita), closes [#160](https://github.com/apify/apify-mcp-server/issues/160)

### 🐛 Bug Fixes

- Handle deprecated tool preview ([#251](https://github.com/apify/apify-mcp-server/pull/251)) ([ff565f7](https://github.com/apify/apify-mcp-server/commit/ff565f7a77b57dd847411466c961f427ba56c371)) by [@jirispilka](https://github.com/jirispilka), closes [#252](https://github.com/apify/apify-mcp-server/issues/252)


## [0.4.4](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.4) (2025-08-28)

### 🐛 Bug Fixes

- Add resource list method to prevent client not respecting capabilities from crashing, update manifest.json for dxt ([#249](https://github.com/apify/apify-mcp-server/pull/249)) ([1dca956](https://github.com/apify/apify-mcp-server/commit/1dca956e5deb3efbb604005710fdbf2794202321)) by [@MQ37](https://github.com/MQ37)


## [0.4.3](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.3) (2025-08-27)

### 🐛 Bug Fixes

- Dxt manifest fix prompts ([#246](https://github.com/apify/apify-mcp-server/pull/246)) ([7c89f38](https://github.com/apify/apify-mcp-server/commit/7c89f388c40e756a5f9fcad18ffe31e960962343)) by [@MQ37](https://github.com/MQ37)


## [0.4.2](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.2) (2025-08-27)


## [0.4.1](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.1) (2025-08-27)

### 🚀 Features

- Implement mcp logging set level request handler ([#242](https://github.com/apify/apify-mcp-server/pull/242)) ([339d556](https://github.com/apify/apify-mcp-server/commit/339d556bd378c36e3091515bda7d6086cdda69ab)) by [@MQ37](https://github.com/MQ37), closes [#231](https://github.com/apify/apify-mcp-server/issues/231)


## [0.4.0](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.0) (2025-08-26)


## [0.4.0](https://github.com/apify/apify-mcp-server/releases/tag/v0.4.0) (2025-08-26)

### 🚀 Features

- **input:** Allow empty tools and actors to allow  greater control of exposed tools ([#218](https://github.com/apify/apify-mcp-server/pull/218)) ([a4a8638](https://github.com/apify/apify-mcp-server/commit/a4a86389fb65bed099974993ab34b63f7159064d)) by [@MQ37](https://github.com/MQ37), closes [#214](https://github.com/apify/apify-mcp-server/issues/214)

### 🐛 Bug Fixes

- Description in package.json and manifest.json ([#234](https://github.com/apify/apify-mcp-server/pull/234)) ([9f4bcfa](https://github.com/apify/apify-mcp-server/commit/9f4bcfa59df231d12efe1ca574641943c1d1e26e)) by [@jirispilka](https://github.com/jirispilka)
- Change github repository links ([#237](https://github.com/apify/apify-mcp-server/pull/237)) ([6216fa4](https://github.com/apify/apify-mcp-server/commit/6216fa40638616c481ce401cd671a112e897e42a)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.9](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.9) (2025-08-21)


## [0.3.9](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.9) (2025-08-21)

### 🚀 Features

- **dxt:** Add mcp tool configuration options ([#221](https://github.com/apify/actors-mcp-server/pull/221)) ([5b305c5](https://github.com/apify/actors-mcp-server/commit/5b305c5239ae515a966c055b356d0bc3b90ee301)) by [@MQ37](https://github.com/MQ37), closes [#219](https://github.com/apify/actors-mcp-server/issues/219)
- Prepare for dockerhub integration, prepare dockerfile, add support for reading config from env vars for stdio ([#224](https://github.com/apify/actors-mcp-server/pull/224)) ([08c62be](https://github.com/apify/actors-mcp-server/commit/08c62be284032bc1d5f4ccb25301129fc1ea2c58)) by [@MQ37](https://github.com/MQ37)

### 🐛 Bug Fixes

- Improve beta release cicd ([#202](https://github.com/apify/actors-mcp-server/pull/202)) ([2bd1ad7](https://github.com/apify/actors-mcp-server/commit/2bd1ad74e2aec01d7ae37750846abe3fbf66a4e7)) by [@MQ37](https://github.com/MQ37), closes [#80](https://github.com/apify/actors-mcp-server/issues/80)
- Actor input transform array items type inference ([#225](https://github.com/apify/actors-mcp-server/pull/225)) ([eb38160](https://github.com/apify/actors-mcp-server/commit/eb381603edd00c82678c89a2fa6aa31720295e99)) by [@MQ37](https://github.com/MQ37), closes [#217](https://github.com/apify/actors-mcp-server/issues/217)
- Dockerhub init unauth server start and tool list ([#227](https://github.com/apify/actors-mcp-server/pull/227)) ([87b2f2c](https://github.com/apify/actors-mcp-server/commit/87b2f2c470e1bddc92a568e8e826fc2ed8bfc1a9)) by [@MQ37](https://github.com/MQ37)
- Dxt rename sever to apify-mcp-server ([#232](https://github.com/apify/actors-mcp-server/pull/232)) ([c5e51df](https://github.com/apify/actors-mcp-server/commit/c5e51df79c3a6dd037f114d4aa4bd3ecf7db8641)) by [@MQ37](https://github.com/MQ37)


## [0.3.8](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.8) (2025-08-08)

### 🐛 Bug Fixes

- Change log message for actor-mcp ([#211](https://github.com/apify/actors-mcp-server/pull/211)) ([3697b9f](https://github.com/apify/actors-mcp-server/commit/3697b9f48ab3c3b51dfe773375f6493197df7fa9)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.7](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.7) (2025-08-07)

### 🐛 Bug Fixes

- Change description in DXT file ([#209](https://github.com/apify/actors-mcp-server/pull/209)) ([4608963](https://github.com/apify/actors-mcp-server/commit/460896398d4f5999f8154bb51d09c254552d6224)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.6](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.6) (2025-08-06)

### 🚀 Features

- Update dxt file ([#208](https://github.com/apify/actors-mcp-server/pull/208)) ([1bedc59](https://github.com/apify/actors-mcp-server/commit/1bedc59cb4a0e3bf5abd493298ec4fecb9c40fef)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.5](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.5) (2025-08-06)

### 🐛 Bug Fixes

- Adding non existent Actor ([#205](https://github.com/apify/actors-mcp-server/pull/205)) ([b82fb1b](https://github.com/apify/actors-mcp-server/commit/b82fb1b15a734a556dad171ed428d4440c6176f1)) by [@MQ37](https://github.com/MQ37)


## [0.3.4](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.4) (2025-08-06)

### 🚀 Features

- Change logs to structured format ([#207](https://github.com/apify/actors-mcp-server/pull/207)) ([3f30e1d](https://github.com/apify/actors-mcp-server/commit/3f30e1dcb5c70767ddbbe375ef7ae8ba06a29e66)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.3](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.3) (2025-08-05)

### 🚀 Features

- Change info logs to debug ([#204](https://github.com/apify/actors-mcp-server/pull/204)) ([1f45d7f](https://github.com/apify/actors-mcp-server/commit/1f45d7fb45dbd18e69687eeb89fb098969a6228d)) by [@jirispilka](https://github.com/jirispilka)


## [0.3.2](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.2) (2025-08-01)

### 🚀 Features

- Add images with a new Apify logo ([#191](https://github.com/apify/actors-mcp-server/pull/191)) ([cc5ded9](https://github.com/apify/actors-mcp-server/commit/cc5ded9e6f1b5f325dd4010c67b1ba920aa3350e)) by [@jirispilka](https://github.com/jirispilka)
- Add tool to get dataset schema so LLMs can understand dataset structure without fetching everything ([#190](https://github.com/apify/actors-mcp-server/pull/190)) ([9ad36d1](https://github.com/apify/actors-mcp-server/commit/9ad36d1a6ea29abbb310549183a060063bec5269)) by [@jirispilka](https://github.com/jirispilka)
- Return Actor card in markdown ([#195](https://github.com/apify/actors-mcp-server/pull/195)) ([bfd9016](https://github.com/apify/actors-mcp-server/commit/bfd9016726d237dc2fa7e6b6e1bce2c177cfdc54)) by [@jirispilka](https://github.com/jirispilka), closes [#181](https://github.com/apify/actors-mcp-server/issues/181)
- Handle Apify specific input schema props ([#196](https://github.com/apify/actors-mcp-server/pull/196)) ([820cff8](https://github.com/apify/actors-mcp-server/commit/820cff8f6bfa87467c1fa58c93794d1a9017ca6d)) by [@MQ37](https://github.com/MQ37), closes [#182](https://github.com/apify/actors-mcp-server/issues/182)
- Tools dump ([#199](https://github.com/apify/actors-mcp-server/pull/199)) ([b657795](https://github.com/apify/actors-mcp-server/commit/b657795b052ddbf5abc1c4300cb0f663b8abce71)) by [@MQ37](https://github.com/MQ37)

### 🐛 Bug Fixes

- Failing integration test ([#200](https://github.com/apify/actors-mcp-server/pull/200)) ([a48aa0a](https://github.com/apify/actors-mcp-server/commit/a48aa0a3b9f4108b913746529bf800680b57fb98)) by [@MQ37](https://github.com/MQ37)



## [0.3.1](https://github.com/apify/actors-mcp-server/releases/tag/v0.3.1) (2025-07-24)

### 🚀 Features

- Release dxt format ([#178](https://github.com/apify/actors-mcp-server/pull/178)) ([0845205](https://github.com/apify/actors-mcp-server/commit/084520524d0c06cbb8be0d18579e180d077a8af7)) by [@MQ37](https://github.com/MQ37)
- Prompts ([#187](https://github.com/apify/actors-mcp-server/pull/187)) ([e672ff2](https://github.com/apify/actors-mcp-server/commit/e672ff2aa69d6f0af5f4998068763905e46b0110)) by [@MQ37](https://github.com/MQ37), closes [#109](https://github.com/apify/actors-mcp-server/issues/109)

### 🐛 Bug Fixes

- Export internals for apify-mcp-server ([#179](https://github.com/apify/actors-mcp-server/pull/179)) ([e1f529d](https://github.com/apify/actors-mcp-server/commit/e1f529d877def284e7622a220c042eb9dcb1fb9d)) by [@MQ37](https://github.com/MQ37)


## [0.2.15](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.15) (2025-07-21)

### 🚀 Features

- Add video tutorial into the Actor README. Simplify README ([#175](https://github.com/apify/actors-mcp-server/pull/175)) ([3547521](https://github.com/apify/actors-mcp-server/commit/3547521e23bbf9a5d49cb75f8ff275e88dfe5be4)) by [@jirispilka](https://github.com/jirispilka), closes [#138](https://github.com/apify/actors-mcp-server/issues/138), [#148](https://github.com/apify/actors-mcp-server/issues/148)
- Progress notification ([#173](https://github.com/apify/actors-mcp-server/pull/173)) ([a562f64](https://github.com/apify/actors-mcp-server/commit/a562f642d91f307740eaafcca464f463c512448e)) by [@MichalKalita](https://github.com/MichalKalita), closes [#149](https://github.com/apify/actors-mcp-server/issues/149)
- Update README, make it shorter and concise ([#176](https://github.com/apify/actors-mcp-server/pull/176)) ([134a4ae](https://github.com/apify/actors-mcp-server/commit/134a4aebc3ddfd6b16bba1b49c859b8abe204e56)) by [@jirispilka](https://github.com/jirispilka)

### 🐛 Bug Fixes

- Embed thumbnail in README.md ([#177](https://github.com/apify/actors-mcp-server/pull/177)) ([b634125](https://github.com/apify/actors-mcp-server/commit/b6341254e94892bfce0f4a652b0af548923af81a)) by [@jirispilka](https://github.com/jirispilka)


## [0.2.14](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.14) (2025-07-17)

### 🚀 Features

- Add tool selection by feature param ([#172](https://github.com/apify/actors-mcp-server/pull/172)) ([f3b2e4f](https://github.com/apify/actors-mcp-server/commit/f3b2e4f1d204ab01cd0783bbc9930bfc2f84a539)) by [@MQ37](https://github.com/MQ37), closes [#166](https://github.com/apify/actors-mcp-server/issues/166)

### 🐛 Bug Fixes

- Encode Actor input fields containing dots ([#170](https://github.com/apify/actors-mcp-server/pull/170)) ([8dbdc7b](https://github.com/apify/actors-mcp-server/commit/8dbdc7b53da50137fd118631404312c71d8f4381)) by [@MQ37](https://github.com/MQ37)


## [0.2.13](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.13) (2025-07-15)

### 🐛 Bug Fixes

- Actor tool input schema, docs search normalized query ([#168](https://github.com/apify/actors-mcp-server/pull/168)) ([01de757](https://github.com/apify/actors-mcp-server/commit/01de7578cc2276b820410b56a3fb55dc00cb146f)) by [@MQ37](https://github.com/MQ37)


## [0.2.12](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.12) (2025-07-09)

### 🐛 Bug Fixes

- Tool loading by name for beta tools ([#165](https://github.com/apify/actors-mcp-server/pull/165)) ([9bea357](https://github.com/apify/actors-mcp-server/commit/9bea357739ba844c5f9dbda200025857b464a630)) by [@MQ37](https://github.com/MQ37)


## [0.2.11](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.11) (2025-07-09)

### 🐛 Bug Fixes

- Improve generic actor-call tool and hide it behind beta flag ([#164](https://github.com/apify/actors-mcp-server/pull/164)) ([fea5336](https://github.com/apify/actors-mcp-server/commit/fea5336a8cef337e339f7cf0a248c5e52e121635)) by [@MQ37](https://github.com/MQ37)


## [0.2.10](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.10) (2025-07-09)

### 🚀 Features

- Limit tools to discovery, dynamic Actor management, and help; simplify Actor input schema; return all dataset items at once with only relevant fields in outputs ([#158](https://github.com/apify/actors-mcp-server/pull/158)) ([dd7a924](https://github.com/apify/actors-mcp-server/commit/dd7a924a05373c9afc16b585ef3dd0c0a51dc647)) by [@MQ37](https://github.com/MQ37), closes [#121](https://github.com/apify/actors-mcp-server/issues/121), [#152](https://github.com/apify/actors-mcp-server/issues/152), [#153](https://github.com/apify/actors-mcp-server/issues/153), [#159](https://github.com/apify/actors-mcp-server/issues/159)
- Call-actor tool ([#161](https://github.com/apify/actors-mcp-server/pull/161)) ([7d00f9d](https://github.com/apify/actors-mcp-server/commit/7d00f9d3cf78e10a68e9d976783e8463099a407a)) by [@MichalKalita](https://github.com/MichalKalita), closes [#155](https://github.com/apify/actors-mcp-server/issues/155)
- Apify docs tools ([#162](https://github.com/apify/actors-mcp-server/pull/162)) ([9bdb198](https://github.com/apify/actors-mcp-server/commit/9bdb1982907058206df35e24d9e3073664d47f81)) by [@MQ37](https://github.com/MQ37)

### 🐛 Bug Fixes

- Proxy&#x2F;actor mcp server notifications ([#163](https://github.com/apify/actors-mcp-server/pull/163)) ([7c0e613](https://github.com/apify/actors-mcp-server/commit/7c0e6138ef1a25af746f07a3c5730298d121d029)) by [@MQ37](https://github.com/MQ37), closes [#154](https://github.com/apify/actors-mcp-server/issues/154)


## [0.2.9](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.9) (2025-07-03)

### 🚀 Features

- Add support for Actorized MCP servers streamable transport. Refactor Actors as a tool adding logic. Update Apify client and SDK and MCP SDK. Refactor standby Actor MCP web server to support multiple concurrent clients. ([#151](https://github.com/apify/actors-mcp-server/pull/151)) ([c2527af](https://github.com/apify/actors-mcp-server/commit/c2527af22fd29adbff74709d50b5eed1a64032b8)) by [@MQ37](https://github.com/MQ37), closes [#89](https://github.com/apify/actors-mcp-server/issues/89), [#100](https://github.com/apify/actors-mcp-server/issues/100), [#118](https://github.com/apify/actors-mcp-server/issues/118)


## [0.2.8](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.8) (2025-06-24)

### 🚀 Features

- Dynamic actor loading is enabled by default ([#147](https://github.com/apify/actors-mcp-server/pull/147)) ([261e1aa](https://github.com/apify/actors-mcp-server/commit/261e1aa40d88e499121b047fb07f24459fb2b0e1)) by [@MichalKalita](https://github.com/MichalKalita), closes [#144](https://github.com/apify/actors-mcp-server/issues/144)


## [0.2.7](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.7) (2025-06-23)

### 🐛 Bug Fixes

- Explicitly clear resources ([#136](https://github.com/apify/actors-mcp-server/pull/136)) ([779d2ba](https://github.com/apify/actors-mcp-server/commit/779d2ba2407bcd5fbdd89d3201463a784e67c931)) by [@jirispilka](https://github.com/jirispilka)
- Readme Actors list ([#141](https://github.com/apify/actors-mcp-server/pull/141)) ([dc0a332](https://github.com/apify/actors-mcp-server/commit/dc0a332c8dbe450290d4acb5a19759545edf3c32)) by [@MQ37](https://github.com/MQ37)
- Notifications ([#145](https://github.com/apify/actors-mcp-server/pull/145)) ([d96c427](https://github.com/apify/actors-mcp-server/commit/d96c42775db86f563c1012285c4a42f12fc23a19)) by [@MQ37](https://github.com/MQ37)
- Disable search for rental Actors ([#142](https://github.com/apify/actors-mcp-server/pull/142)) ([d7bdb9e](https://github.com/apify/actors-mcp-server/commit/d7bdb9e958e5250c7f06b282512e4d98150e24bb)) by [@MQ37](https://github.com/MQ37), closes [#135](https://github.com/apify/actors-mcp-server/issues/135)


## [0.2.6](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.6) (2025-06-13)

### 🐛 Bug Fixes

- Fixed ajv compile also for MCP proxy tools ([#140](https://github.com/apify/actors-mcp-server/pull/140)) ([5e6e618](https://github.com/apify/actors-mcp-server/commit/5e6e6189984b1cd8bcbbd986d63888810695367a)) by [@MQ37](https://github.com/MQ37)


## [0.2.5](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.5) (2025-06-13)

### 🐛 Bug Fixes

- Ajv compile memory leak ([#139](https://github.com/apify/actors-mcp-server/pull/139)) ([924053e](https://github.com/apify/actors-mcp-server/commit/924053e372ebbb39e4e96ca5abf14bae2b2dfde9)) by [@MQ37](https://github.com/MQ37)


## [0.2.4](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.4) (2025-06-04)

### 🚀 Features

- Update image in README and fix Actor README ([#134](https://github.com/apify/actors-mcp-server/pull/134)) ([2fcd4c0](https://github.com/apify/actors-mcp-server/commit/2fcd4c00b682f5080d5e57da10a74a3801cb87ee)) by [@jirispilka](https://github.com/jirispilka)


## [0.2.3](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.3) (2025-06-04)

### 🐛 Bug Fixes

- Hack tool call from claude-desktop. Claude is using prefix local ([#133](https://github.com/apify/actors-mcp-server/pull/133)) ([4dd3a6d](https://github.com/apify/actors-mcp-server/commit/4dd3a6d135989d9de8c1f4dd4c11c5e1638b4a55)) by [@jirispilka](https://github.com/jirispilka)


## [0.2.2](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.2) (2025-05-30)

### 🚀 Features

- Update Readme.md with legacy information ([#129](https://github.com/apify/actors-mcp-server/pull/129)) ([0b2b329](https://github.com/apify/actors-mcp-server/commit/0b2b329a7bc2dfc764fcc9a368d813e2d2acce46)) by [@vystrcild](https://github.com/vystrcild)

### 🐛 Bug Fixes

- Actor add response ([#128](https://github.com/apify/actors-mcp-server/pull/128)) ([8754dd2](https://github.com/apify/actors-mcp-server/commit/8754dd2767581f026048aa58fdc44798711fc4dc)) by [@MQ37](https://github.com/MQ37)
- Error and input handling ([#130](https://github.com/apify/actors-mcp-server/pull/130)) ([0b0331c](https://github.com/apify/actors-mcp-server/commit/0b0331cfde11501b528b86b192abb513682cd0cd)) by [@MQ37](https://github.com/MQ37)


## [0.2.0](https://github.com/apify/actors-mcp-server/releases/tag/v0.2.0) (2025-05-26)

### 🚀 Features

- Normal Actor tools cache ([#117](https://github.com/apify/actors-mcp-server/pull/117)) ([1a3ce16](https://github.com/apify/actors-mcp-server/commit/1a3ce16026d44e49fc1b930c03cae2f4631d11ca)) by [@MQ37](https://github.com/MQ37)
- Tool state handler ([#116](https://github.com/apify/actors-mcp-server/pull/116)) ([681c466](https://github.com/apify/actors-mcp-server/commit/681c466e0f06352fa528e1a56f6bbe93d0207312)) by [@MQ37](https://github.com/MQ37)
- Add Actor runs API, dataset API, KV-store  ([#122](https://github.com/apify/actors-mcp-server/pull/122)) ([7b99e85](https://github.com/apify/actors-mcp-server/commit/7b99e85c46f3e930fa34bc9f4afc8898f0281483)) by [@jirispilka](https://github.com/jirispilka), closes [#79](https://github.com/apify/actors-mcp-server/issues/79)

### 🐛 Bug Fixes

- Apify-mcp-server max listeners warning ([#113](https://github.com/apify/actors-mcp-server/pull/113)) ([219f8ee](https://github.com/apify/actors-mcp-server/commit/219f8eeea3174b6cd44af08d563d2f65db23aa3f)) by [@MQ37](https://github.com/MQ37)
- Use a new API to get Actor default build ([#114](https://github.com/apify/actors-mcp-server/pull/114)) ([6236e44](https://github.com/apify/actors-mcp-server/commit/6236e442455522c10fcd8a3ac7a91d086f941378)) by [@jirispilka](https://github.com/jirispilka)
- Update README.md ([#123](https://github.com/apify/actors-mcp-server/pull/123)) ([2b82932](https://github.com/apify/actors-mcp-server/commit/2b82932e19af7bc808536e5dd084904e467d99f1)) by [@samehjarour](https://github.com/samehjarour)
- Cli help ([#125](https://github.com/apify/actors-mcp-server/pull/125)) ([2fe5211](https://github.com/apify/actors-mcp-server/commit/2fe52117c94198022e8585df40418bca09efeee9)) by [@MQ37](https://github.com/MQ37), closes [#124](https://github.com/apify/actors-mcp-server/issues/124)
- Update mcp sdk ([#127](https://github.com/apify/actors-mcp-server/pull/127)) ([eed238e](https://github.com/apify/actors-mcp-server/commit/eed238ed803e3de6fca0338d2b97a25fab0669e7)) by [@MQ37](https://github.com/MQ37), closes [#84](https://github.com/apify/actors-mcp-server/issues/84)


## [0.1.30](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.30) (2025-05-07)

### 🐛 Bug Fixes

- Stdio print error ([#101](https://github.com/apify/actors-mcp-server/pull/101)) ([1964e69](https://github.com/apify/actors-mcp-server/commit/1964e69f5bcf64e47892b4d09044ac40ccd97ac9)) by [@MQ37](https://github.com/MQ37)
- Actor server default tool loading ([#104](https://github.com/apify/actors-mcp-server/pull/104)) ([f4eca84](https://github.com/apify/actors-mcp-server/commit/f4eca8471a933e48ceecf70edf8a8657a27c7978)) by [@MQ37](https://github.com/MQ37)
- Stdio and streamable http client examples ([#106](https://github.com/apify/actors-mcp-server/pull/106)) ([8d58bfa](https://github.com/apify/actors-mcp-server/commit/8d58bfaee377877968c96aa465f0125159b84e8b)) by [@MQ37](https://github.com/MQ37), closes [#105](https://github.com/apify/actors-mcp-server/issues/105)
- Update README with a link to a blog post ([#112](https://github.com/apify/actors-mcp-server/pull/112)) ([bfe9286](https://github.com/apify/actors-mcp-server/commit/bfe92861c8f85c4af50d77c94173e4abedca8f57)) by [@jirispilka](https://github.com/jirispilka), closes [#65](https://github.com/apify/actors-mcp-server/issues/65)


## [0.1.29](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.29) (2025-04-29)

### 🐛 Bug Fixes

- Add tool call timeout ([#93](https://github.com/apify/actors-mcp-server/pull/93)) ([409ad50](https://github.com/apify/actors-mcp-server/commit/409ad50569e5bd2e3dff950c11523a8440a98034)) by [@MQ37](https://github.com/MQ37)
- Adds glama.json file to allow claim the server on Glama ([#95](https://github.com/apify/actors-mcp-server/pull/95)) ([b57fe24](https://github.com/apify/actors-mcp-server/commit/b57fe243e9c12126ed2aaf7b830d7fa45f7a7d1c)) by [@jirispilka](https://github.com/jirispilka), closes [#85](https://github.com/apify/actors-mcp-server/issues/85)
- Code improvements ([#91](https://github.com/apify/actors-mcp-server/pull/91)) ([b43361a](https://github.com/apify/actors-mcp-server/commit/b43361ab63402dc1f64487e01e32024d517c91b5)) by [@MQ37](https://github.com/MQ37)
- Rename tools ([#99](https://github.com/apify/actors-mcp-server/pull/99)) ([45ffae6](https://github.com/apify/actors-mcp-server/commit/45ffae60e8209b5949a3ad04f65faad73faa50d8)) by [@MQ37](https://github.com/MQ37), closes [#98](https://github.com/apify/actors-mcp-server/issues/98)


## [0.1.28](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.28) (2025-04-22)

### 🐛 Bug Fixes

- Default actors not loaded ([#94](https://github.com/apify/actors-mcp-server/pull/94)) ([fde4c3b](https://github.com/apify/actors-mcp-server/commit/fde4c3b0d66195439d2677d0ac33a08bc77b84cd)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.27](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.27) (2025-04-22)

### 🐛 Bug Fixes

- Move logic to enableAddingActors and enableDefaultActors to constructor ([#90](https://github.com/apify/actors-mcp-server/pull/90)) ([0f44740](https://github.com/apify/actors-mcp-server/commit/0f44740ed3c34a15d938133ac30254afe5d81c57)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.26](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.26) (2025-04-22)

### 🐛 Bug Fixes

- Readme smithery ([#92](https://github.com/apify/actors-mcp-server/pull/92)) ([e585cf3](https://github.com/apify/actors-mcp-server/commit/e585cf394a16aa9891428106d91c443ce9791001)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.25](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.25) (2025-04-21)

### 🐛 Bug Fixes

- Load actors as tools dynamically based on input ([#87](https://github.com/apify/actors-mcp-server/pull/87)) ([5238225](https://github.com/apify/actors-mcp-server/commit/5238225a08094e7959a21c842c4c56cfaae1e8f8)) by [@jirispilka](https://github.com/jirispilka), closes [#88](https://github.com/apify/actors-mcp-server/issues/88)


## [0.1.24](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.24) (2025-04-21)

### 🚀 Features

- Decouple Actor from mcp-server, add ability to call Actorized MCP and load tools ([#59](https://github.com/apify/actors-mcp-server/pull/59)) ([fe8d9c2](https://github.com/apify/actors-mcp-server/commit/fe8d9c22c404eb8a22cdce70feb81ca166eb4f7f)) by [@MQ37](https://github.com/MQ37), closes [#55](https://github.com/apify/actors-mcp-server/issues/55), [#56](https://github.com/apify/actors-mcp-server/issues/56)

### 🐛 Bug Fixes

- Update search tool description ([#82](https://github.com/apify/actors-mcp-server/pull/82)) ([43e6dab](https://github.com/apify/actors-mcp-server/commit/43e6dab1883b5dd4e915f475e2d7f71e892ed0bf)) by [@jirispilka](https://github.com/jirispilka), closes [#78](https://github.com/apify/actors-mcp-server/issues/78)
- Load default Actors for the &#x2F;mcp route ([#86](https://github.com/apify/actors-mcp-server/pull/86)) ([b01561f](https://github.com/apify/actors-mcp-server/commit/b01561fd7dbd8061606b226ee6977403969e7b48)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.23](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.23) (2025-04-16)

### 🐛 Bug Fixes

- Add default Actors in standby mode ([#77](https://github.com/apify/actors-mcp-server/pull/77)) ([4b44e78](https://github.com/apify/actors-mcp-server/commit/4b44e7869549697ff2256a7794e61e3cfec3dd4e)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.22](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.22) (2025-04-16)

### 🐛 Bug Fixes

- Deprecate enableActorAutoLoading in favor of enable-adding-actors, and load tools only if not provided in query parameter ([#63](https://github.com/apify/actors-mcp-server/pull/63)) ([8add54c](https://github.com/apify/actors-mcp-server/commit/8add54ce94952bc23653b1f5c6c568e51589ffa5)) by [@jirispilka](https://github.com/jirispilka), closes [#54](https://github.com/apify/actors-mcp-server/issues/54)
- CI ([#75](https://github.com/apify/actors-mcp-server/pull/75)) ([3433a39](https://github.com/apify/actors-mcp-server/commit/3433a39305f59c7964401a3d68db06cb47bb243a)) by [@jirispilka](https://github.com/jirispilka)
- Add tools with query parameter ([#76](https://github.com/apify/actors-mcp-server/pull/76)) ([dc9a07a](https://github.com/apify/actors-mcp-server/commit/dc9a07a37db076eb9fe064e726cae6e7bdb2bf0f)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.21](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.21) (2025-03-27)

### 🐛 Bug Fixes

- Update README for a localhost configuration ([#52](https://github.com/apify/actors-mcp-server/pull/52)) ([82e8f6c](https://github.com/apify/actors-mcp-server/commit/82e8f6c2c7d1b3284f1c6f6f583caac5eb2973a1)) by [@jirispilka](https://github.com/jirispilka), closes [#51](https://github.com/apify/actors-mcp-server/issues/51)
- Update README.md guide link ([#53](https://github.com/apify/actors-mcp-server/pull/53)) ([cd30df2](https://github.com/apify/actors-mcp-server/commit/cd30df2eed1f87396d3f5a143fdd1bb69a8e00ba)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.20](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.20) (2025-03-21)

### 🚀 Features

- Return run information when MCP server is started in standby mode ([#48](https://github.com/apify/actors-mcp-server/pull/48)) ([880dccb](https://github.com/apify/actors-mcp-server/commit/880dccb812312cfecbe5e5fe55d12b98822d7a05)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.19](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.19) (2025-03-21)

### 🐛 Bug Fixes

- Update readme with correct links ([#47](https://github.com/apify/actors-mcp-server/pull/47)) ([2fe8cde](https://github.com/apify/actors-mcp-server/commit/2fe8cdeb6f50cee88b81b8f8e7b41a97b029c803)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.18](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.18) (2025-03-20)

### 🐛 Bug Fixes

- Truncate properties ([#46](https://github.com/apify/actors-mcp-server/pull/46)) ([3ee4543](https://github.com/apify/actors-mcp-server/commit/3ee4543fd8dde49b72d3323c67c3e25a27ba00ff)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.17](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.17) (2025-03-18)

### 🐛 Bug Fixes

- Tool schema array type infer and nested props ([#45](https://github.com/apify/actors-mcp-server/pull/45)) ([25fd5ad](https://github.com/apify/actors-mcp-server/commit/25fd5ad4cddb31470ff40937b080565442707070)) by [@MQ37](https://github.com/MQ37)


## [0.1.16](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.16) (2025-03-14)

### 🐛 Bug Fixes

- Add enum values and examples to schema property descriptions ([#42](https://github.com/apify/actors-mcp-server/pull/42)) ([e4e5a9e](https://github.com/apify/actors-mcp-server/commit/e4e5a9e0828c3adeb8e6ebbb9a7d1a0987d972b7)) by [@MQ37](https://github.com/MQ37)


## [0.1.15](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.15) (2025-03-13)

### 🐛 Bug Fixes

- InferArrayItemType ([#41](https://github.com/apify/actors-mcp-server/pull/41)) ([64e0955](https://github.com/apify/actors-mcp-server/commit/64e09551a2383bf304e24e96dddff29fa3c50b2f)) by [@MQ37](https://github.com/MQ37)


## [0.1.14](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.14) (2025-03-13)

### 🚀 Features

- Tool-items-type ([#39](https://github.com/apify/actors-mcp-server/pull/39)) ([12344c8](https://github.com/apify/actors-mcp-server/commit/12344c8c68d397caa937684f7082485d6cbf41ad)) by [@MQ37](https://github.com/MQ37)


## [0.1.13](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.13) (2025-03-12)

### 🐛 Bug Fixes

- Update inspector command in readme ([#38](https://github.com/apify/actors-mcp-server/pull/38)) ([4c2323e](https://github.com/apify/actors-mcp-server/commit/4c2323ea3d40fa6742cf59673643d0a9aa8e12ce)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.12](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.12) (2025-03-12)

### 🐛 Bug Fixes

- Rename tool name, sent `notifications&#x2F;tools&#x2F;list_changed` ([#37](https://github.com/apify/actors-mcp-server/pull/37)) ([8a00881](https://github.com/apify/actors-mcp-server/commit/8a00881bd64a13eb5d0bd4cfcbf270bc19570f6b)) by [@jirispilka](https://github.com/jirispilka), closes [#11](https://github.com/apify/actors-mcp-server/issues/11)


## [0.1.11](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.11) (2025-03-06)

### 🐛 Bug Fixes

- Correct readme ([#35](https://github.com/apify/actors-mcp-server/pull/35)) ([9443d86](https://github.com/apify/actors-mcp-server/commit/9443d86aac4db5a1851b664bb2cacd80c38ba429)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.10](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.10) (2025-02-28)

### 🚀 Features

- Update README with a link to relevant blogposts ([#34](https://github.com/apify/actors-mcp-server/pull/34)) ([a7c8ea2](https://github.com/apify/actors-mcp-server/commit/a7c8ea24da243283195822d16b56f135786866f4)) by [@jirispilka](https://github.com/jirispilka)

### 🐛 Bug Fixes

- Update README.md ([#33](https://github.com/apify/actors-mcp-server/pull/33)) ([d053c63](https://github.com/apify/actors-mcp-server/commit/d053c6381939e46da7edce409a529fd1581a8143)) by [@RVCA212](https://github.com/RVCA212)

### Deployment

- Dockerfile and Smithery config ([#29](https://github.com/apify/actors-mcp-server/pull/29)) ([dcd1a91](https://github.com/apify/actors-mcp-server/commit/dcd1a91b83521c58e6dd479054687cb717bf88f2)) by [@calclavia](https://github.com/calclavia)


## [0.1.9](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.9) (2025-02-07)

### 🐛 Bug Fixes

- Stdio and SSE example, improve logging ([#32](https://github.com/apify/actors-mcp-server/pull/32)) ([1b1852c](https://github.com/apify/actors-mcp-server/commit/1b1852cdb49c5de3f8dd48a1d9abc5fd28c58b3a)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.8](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.8) (2025-01-31)

### 🐛 Bug Fixes

- Actor auto loading (corret tool-&gt;Actor name conversion) ([#31](https://github.com/apify/actors-mcp-server/pull/31)) ([45073ea](https://github.com/apify/actors-mcp-server/commit/45073ea49f56784cc4e11bed84c01bcb136b2d8e)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.7](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.7) (2025-01-30)

### 🐛 Bug Fixes

- Add internal tools for Actor discovery ([#28](https://github.com/apify/actors-mcp-server/pull/28)) ([193f098](https://github.com/apify/actors-mcp-server/commit/193f0983255d8170c90109d162589e62ec10e340)) by [@jirispilka](https://github.com/jirispilka)
- Update README.md ([#30](https://github.com/apify/actors-mcp-server/pull/30)) ([23bb32e](https://github.com/apify/actors-mcp-server/commit/23bb32e1f2d5b10d3d557de87cb2d97b5e81921b)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.6](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.6) (2025-01-23)

### 🐛 Bug Fixes

- ClientSse example, update README.md ([#27](https://github.com/apify/actors-mcp-server/pull/27)) ([0449700](https://github.com/apify/actors-mcp-server/commit/0449700a55a8d024e2e1260efa68bb9d0dddec75)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.5](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.5) (2025-01-22)

### 🐛 Bug Fixes

- Add log to stdio ([#25](https://github.com/apify/actors-mcp-server/pull/25)) ([b6e58cd](https://github.com/apify/actors-mcp-server/commit/b6e58cd79f36cfcca1f51b843b5af7ae8e519935)) by [@jirispilka](https://github.com/jirispilka)
- Claude desktop img link ([#26](https://github.com/apify/actors-mcp-server/pull/26)) ([6bd3b75](https://github.com/apify/actors-mcp-server/commit/6bd3b75fb8036e57f6e420392f54030345f0f42d)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.4](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.4) (2025-01-22)

### 🐛 Bug Fixes

- Update README.md ([#22](https://github.com/apify/actors-mcp-server/pull/22)) ([094abc9](https://github.com/apify/actors-mcp-server/commit/094abc95e670c338bd7e90b86f256f4153f92c4d)) by [@jirispilka](https://github.com/jirispilka)
- Remove code check from Release ([#23](https://github.com/apify/actors-mcp-server/pull/23)) ([90cafe6](https://github.com/apify/actors-mcp-server/commit/90cafe6e9b84a237d21ea6d33bfd27a0f81ac915)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.3](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.3) (2025-01-21)

### 🚀 Features

- Update README.md with missing image, and a section on how is MCP related to AI Agents ([#11](https://github.com/apify/actors-mcp-server/pull/11)) ([e922033](https://github.com/apify/actors-mcp-server/commit/e9220332d9ccfbd2efdfb95f07f7c7a52fffc92b)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.2](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.2) (2025-01-21)

### 🚀 Features

- Truncate input schema, limit description to 200 characters ([#10](https://github.com/apify/actors-mcp-server/pull/10)) ([a194765](https://github.com/apify/actors-mcp-server/commit/a1947657fd6f7cf557e5ce24a6bbccb97e875733)) by [@jirispilka](https://github.com/jirispilka)


## [0.1.1](https://github.com/apify/actors-mcp-server/releases/tag/v0.1.1) (2025-01-17)

### 🚀 Features

- MCP server implementation ([#1](https://github.com/apify/actors-mcp-server/pull/1)) ([5e2c9f0](https://github.com/apify/actors-mcp-server/commit/5e2c9f06008304257c887dc3c67eb9ddfd32d6cd)) by [@jirispilka](https://github.com/jirispilka)

### 🐛 Bug Fixes

- Update express routes to correctly handle GET and HEAD requests, fix CI ([#5](https://github.com/apify/actors-mcp-server/pull/5)) ([ec6e9b0](https://github.com/apify/actors-mcp-server/commit/ec6e9b0a4657f673b3650a5906fe00e66411d7f1)) by [@jirispilka](https://github.com/jirispilka)
- Correct publishing of npm module ([#6](https://github.com/apify/actors-mcp-server/pull/6)) ([4c953e9](https://github.com/apify/actors-mcp-server/commit/4c953e9fe0c735f1690c8356884dd78d8608979f)) by [@jirispilka](https://github.com/jirispilka)