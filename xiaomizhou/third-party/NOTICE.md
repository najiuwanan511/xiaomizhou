# Bundled runtime attribution

The complete image contains the unmodified SnowCat Shell runtime built from
https://github.com/DandanLLab/SnowCatQQ/tree/e292824161b038996250d6da37a38d9a26f9ac10
(official v6.0.0). The full upstream LICENSE and SOURCE.txt accompany it in
/opt/xiaomizhou-snowcat. The upstream license is the Limited Redistribution
License for NapCat; its historical name and copyright notices are retained.
See NAPCAT-LICENSE.txt and qq-runtime.lock.json for provenance and checksums.

The checksum-pinned v4.18.42 archive at
https://github.com/XingYunStar/NapCatQQ/releases/tag/v4.18.42
is used only as a build input for Tencent Linux QQ 3.2.34-53644. NapCat Shell
and its updater are not copied into the final image. Linux QQ belongs to
Tencent and retains its accompanying files and notices. The builder must use
a clean source image without personal account data or user plugins.

SnowCat core source is not modified. xiaomizhou wraps its launch and protocol
interfaces, supplies private configuration and signing keys, and changes only
QQ's entry point. Shipped SnowCat defaults and plugins are retained; old config,
cache and logs are excluded and private state is generated on first launch.
