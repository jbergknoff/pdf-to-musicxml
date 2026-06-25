"""
Runs HOMR (https://github.com/liebharc/homr, AGPL-3.0) on each integration
test fixture and writes the recovered MusicXML to tmp/homr-output/.

Run via `make homr-comparison`, which executes this script inside the `homr`
Docker service after installing HOMR with pip. HOMR is AGPL-3.0 — this script
runs it as an external tool; no AGPL code enters the rest of the repo.

Model weights are downloaded by HOMR on first use and cached under
.homr-cache/ (XDG_CACHE_HOME in the compose service).
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
FIXTURES_DIR = HERE.parent / "tests" / "integration" / "fixtures"
OUTPUT_DIR = HERE.parent / "tmp" / "homr-output"

FIXTURE_NAMES = [
    "chant",
    "saltarello",
    "mozart-piano-sonata",
    "binchois",
    "gabriels-bell",
    "elgar-ave-verum",
]


def run_homr(name: str) -> None:
    image_path = FIXTURES_DIR / f"{name}.png"
    if not image_path.exists():
        print(f"[skip] {name}: fixture image not found", file=sys.stderr)
        return

    output_path = OUTPUT_DIR / f"{name}.musicxml"
    if output_path.exists():
        print(f"[cached] {name}")
        return

    print(f"[homr] {name} ...", flush=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_image = Path(tmpdir) / f"{name}.png"
        shutil.copy(image_path, tmp_image)

        result = subprocess.run(
            ["homr", str(tmp_image)],
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.stdout:
            print(result.stdout.strip())
        if result.returncode != 0:
            print(
                f"[error] HOMR exited {result.returncode} on {name}:\n"
                f"{result.stderr.strip()}",
                file=sys.stderr,
            )
            return

        # HOMR writes <input_basename>.musicxml alongside the input file.
        expected = tmp_image.with_suffix(".musicxml")
        if not expected.exists():
            # Fallback: any .musicxml in the temp dir.
            candidates = list(Path(tmpdir).glob("*.musicxml"))
            if not candidates:
                print(
                    f"[error] {name}: no MusicXML output found in temp dir\n"
                    f"  stdout: {result.stdout[:300]}",
                    file=sys.stderr,
                )
                return
            expected = candidates[0]

        shutil.copy(expected, output_path)
        print(f"[done]  {name} -> {output_path.relative_to(HERE.parent.parent)}")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in FIXTURE_NAMES:
        run_homr(name)


if __name__ == "__main__":
    main()
