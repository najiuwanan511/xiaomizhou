# Bundled runtime attribution

The complete image includes an **unmodified NapCat Shell runtime** supplied by
the pinned v4.18.42 archive (or a matching builder-supplied `NAPCAT_BASE_IMAGE`). NapCat copyright © 2024 Mlikiowa.
Original repository: https://github.com/NapNeko/NapCatQQ
Archived distribution: https://github.com/XingYunStar/NapCatQQ/releases/tag/v4.18.42
Checksums, architecture-specific assets and QQ version: `napcat-runtime.lock.json`.
Independent core updates use the stable releases and full Shell ZIP from that
same archive repository, require the GitHub SHA-256 digest, and preserve the
unmodified distribution.
Retained source used to inspect the integration contract:
https://github.com/SaveRepo/NapCatQQ/tree/c5bc48da1fd4af1a08e63546ecc6876a7dd1824b

The image retains the runtime distribution and native libraries, but excludes
its pre-existing config, cache, and logs. Shipped built-in plugins and default
core configuration are retained. The source image must be clean and contain no
personal account state or added user plugins. xiaomizhou creates
its own private state on first launch. NapCat source is not modified. The full
NapCat license accompanies this notice in `NAPCAT-LICENSE.txt`.

Linux QQ is Tencent's software. This integration includes its runtime from the
builder's source image and retains the files and notices provided with it.
The builder must identify the exact NapCat/QQ versions and image digest used for
each published image. The build does not fetch or execute an arbitrary installer
from a mutable web URL.
