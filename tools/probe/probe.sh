#!/bin/bash
# Run the vendor tool once under Wine with a given config.ini and dump the HID traffic.
# Usage: probe.sh <name>   (expects /work/tools/probe/in.ini prepared by the caller)
set -u
NAME="$1"
export WINEPREFIX=/wine WINEDEBUG=-all DISPLAY=:99
mkdir -p /work/tools/probe
cp "/work/tools/probe/in.ini" /app/skins/config/config.ini
rm -f /tmp/hid.log
wineserver -k 2>/dev/null
sleep 1
cd /app
( timeout 90 wine "S700 Gaming Mouse.exe" > /tmp/app.log 2>&1 & )
# wait for the device to be picked up
for i in $(seq 1 100); do
  grep -q "CALL GetCaps" /tmp/hid.log 2>/dev/null && break
  sleep 0.2
done
sleep 3          # let the skinned UI finish drawing
xdotool mousemove 852 850 click 1
# wait for end-of-session marker or timeout
for i in $(seq 1 150); do
  grep -qE "^SET 071810" /tmp/hid.log 2>/dev/null && break
  sleep 0.2
done
sleep 0.5
cp /tmp/hid.log "/work/tools/probe/${NAME}.log" 2>/dev/null
wineserver -k 2>/dev/null
echo "done ${NAME}"
