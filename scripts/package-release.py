#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import stat
import tarfile
import zipfile
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist/release")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    extension_name = f"weixin-channels-video-extension-v{version}.zip"
    skill_name = f"weixin-channels-video-skill-v{version}.tar.gz"
    extension_dir = ROOT / "dist/extension"
    skill_dir = ROOT / "dist/weixin-channels-video"
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    extension_path = output_dir / extension_name
    skill_path = output_dir / skill_name
    write_extension_zip(extension_dir, extension_path)
    write_skill_archive(skill_dir, skill_path)

    checksums = "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
        for path in sorted((extension_path, skill_path), key=lambda item: item.name)
    )
    with (output_dir / "SHA256SUMS").open("w", encoding="ascii", newline="\n") as sums_file:
        sums_file.write(checksums)
    print(f"Built {extension_name}, {skill_name}, and SHA256SUMS in {output_dir}.")


def write_extension_zip(extension_dir, archive_path):
    files = sorted(path for path in extension_dir.rglob("*") if path.is_file())
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for path in files:
            name = path.relative_to(extension_dir).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.flag_bits = 0x800
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, path.read_bytes())


def write_skill_archive(skill_dir, archive_path):
    entries = [(skill_dir, "weixin-channels-video")]
    entries.extend(
        (path, f"weixin-channels-video/{path.relative_to(skill_dir).as_posix()}")
        for path in skill_dir.rglob("*")
    )
    entries.sort(key=lambda item: item[1])

    tar_buffer = BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path, name in entries:
            info = tarfile.TarInfo(name)
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            if path.is_dir():
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.size = 0
                archive.addfile(info)
            elif path.is_file():
                info.type = tarfile.REGTYPE
                info.mode = 0o644
                info.size = path.stat().st_size
                with path.open("rb") as source:
                    archive.addfile(info, source)

    with archive_path.open("wb") as output:
        with gzip.GzipFile(filename="", fileobj=output, mode="wb", compresslevel=9, mtime=0) as compressed:
            compressed.write(tar_buffer.getvalue())


if __name__ == "__main__":
    main()
