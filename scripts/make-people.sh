#!/bin/sh
# Regenerate the people (Anny bodies, via raea's character tool) into runtime/characters/. One-time setup of the Python tool:
#   uv venv -p 3.12 ~/.cache/raea-anny-venv && uv pip install -p ~/.cache/raea-anny-venv/bin/python anny trimesh scipy roma pillow
# Presets: man, woman, kid (sliders: scripts/make-people.sh NAME gender=0.2 height=0.7 ...). Needs ~/sites/raea (a clone of raea).
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
for n in ${@:-man woman kid}; do
  (cd "$HOME/sites/raea" && "$HOME/.cache/raea-anny-venv/bin/python" sdk/raea/tools/anny/character.py "$n" --out "$HERE/runtime/characters")
done
