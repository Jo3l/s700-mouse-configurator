#!/bin/bash
# Herramienta del fabricante en modo interactivo (para grabar macros a mano).
#   ui.sh start | shot <nombre> | click X Y | key <keys> | type <texto> | save <nombre> | stop
set -u
export WINEPREFIX=/wine WINEDEBUG=-all DISPLAY=:99
cd /app || exit 1
case "${1:-}" in
  start)
    wineserver -k 2>/dev/null; sleep 1
    cp /work/tools/probe/in.ini /app/skins/config/config.ini
    rm -f /tmp/hid.log
    ( timeout 300 wine "S700 Gaming Mouse.exe" > /tmp/app.log 2>&1 & )
    for i in $(seq 1 100); do grep -q "CALL GetCaps" /tmp/hid.log 2>/dev/null && break; sleep 0.2; done
    sleep 4
    xdotool search --name "S700" getwindowgeometry 2>/dev/null | tail -2
    echo "arrancado"
    ;;
  shot)
    import -window root "/work/tools/probe/${2:-shot}.png" && echo "/work/tools/probe/${2:-shot}.png"
    ;;
  click) xdotool mousemove "$2" "$3" click 1; echo "click $2 $3" ;;
  move)  xdotool mousemove "$2" "$3"; echo "move $2 $3" ;;
  tap)   xdotool mousemove "$2" "$3"; sleep 0.4; xdotool click 1; sleep 0.3; echo "tap $2 $3" ;;
  focus) xdotool windowfocus "$(xdotool search --name 'S700 Gaming Mouse' | head -1)"; echo "focus" ;;
  key)   xdotool key --clearmodifiers "$2"; echo "key $2" ;;
  type)  xdotool type --delay 60 "$2"; echo "type $2" ;;
  save)  cp /tmp/hid.log "/work/tools/probe/${2:-ui}.log" && echo "guardado ${2:-ui}" ;;
  stop)  wineserver -k 2>/dev/null; echo "parado" ;;
  *) echo "uso: ui.sh start|shot|click|move|key|type|save|stop"; exit 1 ;;
esac
