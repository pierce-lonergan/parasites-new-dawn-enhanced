#!/bin/sh
# GA-core cross-engine harness (POSIX wrapper). Pins JDK 17 and delegates to run.py:
#   sh tools/genome/rhino/run.sh golden|replay|bench
# The javac on PATH may be Java 8 (class version 52), which cannot compile against the Rhino jar (class version 61),
# so JDK 17 is always called by its full path. Override with PNE_JDK17=<jdk17 home>.
set -e
: "${PNE_JDK17:=C:/Program Files/Java/jdk-17.0.15+6}"
export PNE_JDK17
JAVA_HOME="$PNE_JDK17"
export JAVA_HOME
VER=$("$PNE_JDK17/bin/javac" -version 2>&1)
case "$VER" in
  "javac 17"*) ;;
  *) echo "run.sh: PNE_JDK17 must point at a JDK 17 (javac -version said: $VER)"; exit 77 ;;
esac
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PNE_PYTHON:-python}
exec "$PY" "$HERE/run.py" "$@"
