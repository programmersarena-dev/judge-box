#!/bin/sh
# usage: check.sh submission_output expected_output
SUB=$1
EXP=$2

# normalize whitespace: trim trailing spaces and trailing newlines
normalize() {
  sed 's/[ \t]*$//' "$1" | awk 'BEGIN{ORS="\n"} {print}' | sed -e ':a' -e '/^$/{$d;N;ba' -e '}' || true
}

TMP1=$(mktemp)
TMP2=$(mktemp)

normalize "$SUB" > "$TMP1"
normalize "$EXP" > "$TMP2"

if cmp -s "$TMP1" "$TMP2"; then
  echo OK
  rc=0
else
  echo WA
  rc=1
fi

rm -f "$TMP1" "$TMP2"
exit $rc
