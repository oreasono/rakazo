# Fork publishing

Enabling GitHub Actions on a fork runs PR builds and tests without enabling server image
publishing or mobile OTA delivery. These two publishing paths require separate repository
variables under **Settings → Secrets and variables → Actions → Variables**:

| Repository variable | Set to `true` to enable | Trigger after opt-in |
| --- | --- | --- |
| `SERVER_IMAGE_PUBLISH_ENABLED` | GHCR architecture image pushes, manifests and attestations | Main pushes, `v*` tags, or manual `publish-server-image` dispatch |
| `MOBILE_OTA_PUBLISH_ENABLED` | Production-channel Expo OTA updates | Main pushes after all CI dependencies pass and the existing OTA compatibility checks approve the changes |
| `PRODUCTION_DEPLOY_ENABLED` | Existing production deployment job | Main pushes after all CI dependencies pass |

Unset or `false` leaves each fork publishing path disabled. The two publishing gates preserve
the existing behavior for the exact upstream repository, `elie222/rakazo`. Production deployment
still requires its own explicit opt-in everywhere, including upstream. Enabling image or OTA
publishing does not enable deployment. PR image builds remain read-only with `push: false`.

Before opting in, configure the intended destination: images publish to this repository's
`ghcr.io/<owner>/<repository>/...` namespace; OTA uses the Expo project configured in
`apps/mobile` and requires an authorized `EXPO_TOKEN`. Configure your own Expo project and
native runtime/channel before enabling OTA. The gate does not retarget inherited project
settings or create credentials. See [mobile release setup](mobile-release.md) and
[self-hosted images](self-host.md#published-images-no-checkout).

These variables cover the jobs named above. The inherited desktop release workflow still
runs from `v*` tags or manual dispatch and validates a stable release tag; Android APK release
is manually dispatched. Playwright report publication remains a separate CI-completion
workflow that can upload its report and comment on a PR when configured. Standard CI still
uploads test artifacts. The nightly visual workflow and manually dispatched Android screenshot
workflow can also publish galleries with configured credentials. The scheduled model-catalog
workflow can push an update branch and open a PR. These existing paths are unchanged; review
them before enabling their schedules, creating release tags or configuring credentials.

Offline validation, also run by the CI lint job:

```sh
ruby .github/workflows/publishing-gates.test.rb
```

The test uses Ruby's YAML parser and a restricted condition evaluator, with no network calls,
credentials or third-party gems. It checks workflow YAML syntax and the actual publishing
conditions across fork/upstream, unset/false/enabled variables, PR/main/tag/manual events,
independent deployment gating, and continued PR build/test availability. It does not dispatch
GitHub Actions or validate remote secrets and destinations.
