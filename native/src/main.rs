#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! Host nativo del configurador S700.
//!
//! Sirve la UI de web/ desde dentro del binario (127.0.0.1, sólo local), abre
//! el navegador y hace de puente con el HID del ratón. La página no cambia: en
//! lugar de navigator.hid usa el enchufe de web/bridge.js, que este proceso
//! inyecta al servir el HTML.
//!
//! HTTP a mano sobre std, hidraw en Linux e hid.dll en Windows; la ventana es
//! un WebView del sistema (WebView2 / WebKitGTK) vía wry.

mod hid;
mod ui;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const INDEX: &str = include_str!("../../web/index.html");
const STYLE: &str = include_str!("../../web/style.css");
const APP: &str = include_str!("../../web/app.js");
const G6: &str = include_str!("../../web/g6.js");
const CORE: &str = include_str!("../../web/core.js");
const STORE: &str = include_str!("../../web/storage.js");
const IMAGE: &str = include_str!("../../web/default_image.js");
const BRIDGE: &str = include_str!("../../web/bridge.js");
const MOUSE_PNG: &[u8] = include_bytes!("../../web/mouse.png");
// la regla udev viaja dentro del binario: --install-rule la escribe y recarga udev
const RULES: &str = include_str!("../99-s700-hid.rules");
const RULES_PATH: &str = "/etc/udev/rules.d/99-s700-hid.rules";

const DEFAULT_PORT: u16 = 8760;

struct Host {
    dev: Mutex<Option<hid::Device>>,
}

fn main() {
    #[cfg(windows)]
    attach_console();

    let mut port = DEFAULT_PORT;
    let mut launch = true;
    let mut app_window = true;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                if let Some(v) = args.get(i + 1) {
                    match v.parse::<u16>() {
                        Ok(p) => port = p,
                        Err(_) => {
                            eprintln!("invalid port: {v}");
                            std::process::exit(2);
                        }
                    }
                    i += 1;
                }
            }
            "--no-open" => launch = false,
            "--browser" => app_window = false,
            "--list" => {
                let devs = hid::enumerate();
                if devs.is_empty() {
                    println!("no interfaces with vendor page 0xFF00 in sight");
                }
                for d in devs {
                    println!("{}\t{:04x}:{:04x}\t{}", d.path, d.vid, d.pid, d.name);
                }
                return;
            }
            "--install-rule" => {
                let (ok, log) = elevate_install();
                print!("{log}");
                if !log.ends_with('\n') {
                    println!();
                }
                std::process::exit(if ok { 0 } else { 1 });
            }
            "-h" | "--help" => {
                help();
                return;
            }
            other => {
                eprintln!("unknown argument «{other}»");
                help();
                std::process::exit(2);
            }
        }
        i += 1;
    }
    serve(port, launch, app_window);
}

/// En Windows release el .exe es de subsistema GUI (no abre consola al hacer
/// doble clic). Si lo lanzas desde cmd, se engancha a esa consola para que
/// --list, --help y --install-rule sigan escribiendo donde toca.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = 0xffff_ffff;
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn help() {
    println!(
        "s700-host [--port N] [--no-open] [--browser] [--list] [--install-rule]

  --port N        local port ({DEFAULT_PORT} by default); keep it so the browser
                  storage (localStorage) stays the same
  --no-open       do not open anything
  --browser       open the UI in the default browser instead of the app window
  --list          list the mouse's HID interfaces and exit
  --install-rule  Linux only: write the udev rule that lets this user open
                  /dev/hidraw*, then reload udev; asks for your password with
                  pkexec, so there is no cp and no terminal needed"
    );
}


fn is_root() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            if let Some(line) = status.lines().find(|l| l.starts_with("Uid:")) {
                return line.split_whitespace().nth(1) == Some("0");
            }
        }
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn rule_installed() -> bool {
    std::path::Path::new(RULES_PATH).exists()
}

fn node_writable(node: &str) -> bool {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(node)
        .is_ok()
}

/// Escribe la regla y recarga udev. Sólo tiene sentido como root.
fn install_rule_as_root() -> (bool, String) {
    if let Err(e) = std::fs::write(RULES_PATH, RULES) {
        return (false, format!("cannot write {RULES_PATH}: {e}\n"));
    }
    let mut log = format!("wrote {RULES_PATH}\n");
    for args in [vec!["control", "--reload-rules"], vec!["trigger"]] {
        match std::process::Command::new("udevadm").args(&args).output() {
            Ok(out) if out.status.success() => log.push_str(&format!("udevadm {} ok\n", args.join(" "))),
            Ok(out) => log.push_str(&format!(
                "udevadm {}: {}\n",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => log.push_str(&format!("udevadm {}: {e}\n", args.join(" "))),
        }
    }
    log.push_str("unplug and replug the mouse if the node does not switch owner right away\n");
    (true, log)
}

/// Instala la regla: directa si ya somos root, si no reejecutándose con pkexec,
/// que es lo que muestra el diálogo de contraseña del escritorio.
fn elevate_install() -> (bool, String) {
    if is_root() {
        return install_rule_as_root();
    }
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "s700-host".to_string());
    match std::process::Command::new("pkexec")
        .arg(&exe)
        .arg("--install-rule")
        .output()
    {
        Ok(out) if out.status.success() => {
            (true, String::from_utf8_lossy(&out.stdout).trim().to_string() + "\n")
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.is_empty() {
                (false, "pkexec was cancelled\n".to_string())
            } else {
                (false, format!("pkexec: {err}\n"))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            false,
            format!(
                "no pkexec on this system. Run once, by hand:\n  \
                 sudo {exe} --install-rule\n"
            ),
        ),
        Err(e) => (false, format!("pkexec: {e}\n")),
    }
}

/// Estado que consulta la UI para ofrecer el botón de instalar la regla.
fn permissions_json() -> String {
    #[cfg(target_os = "linux")]
    {
        let devs = hid::enumerate();
        let node = devs.first().map(|d| d.path.clone());
        let writable = node.as_ref().map(|n| node_writable(n)).unwrap_or(false);
        let needed = node.is_some() && !writable;
        let node_json = match &node {
            Some(n) => format!("\"{}\"", esc(n)),
            None => "null".to_string(),
        };
        format!(
            "{{\"ok\":true,\"platform\":\"linux\",\"needed\":{needed},\"root\":{},\"ruleInstalled\":{},\"node\":{node_json},\"writable\":{writable}}}",
            is_root(),
            rule_installed()
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        String::from(
            "{\"ok\":true,\"platform\":\"windows\",\"needed\":false,\"root\":false,\"ruleInstalled\":true,\"node\":null,\"writable\":true}",
        )
    }
}

fn install_rule_json() -> String {
    #[cfg(target_os = "linux")]
    {
        let (ok, log) = elevate_install();
        format!("{{\"ok\":{ok},\"log\":\"{}\"}}", esc(log.trim()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        String::from("{\"ok\":true,\"log\":\"nothing to do on Windows\"}")
    }
}

fn serve(port: u16, launch: bool, app_window: bool) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on 127.0.0.1:{port}: {e}");
            eprintln!("try --port {0}", port.saturating_add(1).max(1024));
            std::process::exit(1);
        }
    };
    let url = format!("http://127.0.0.1:{port}/");
    let host = Arc::new(Host { dev: Mutex::new(None) });

    println!("s700-host · {url}");
    let devs = hid::enumerate();
    if devs.is_empty() {
        println!("  mouse: not found (0 interfaces 0xFF00) — plug it in and press Connect");
    } else {
        for d in &devs {
            println!("  mouse: {} {:04x}:{:04x} {}", d.path, d.vid, d.pid, d.name);
        }
    }
    println!("  Ctrl+C to stop");

    if launch && app_window {
        // La ventana (WebView) tiene que correr en el hilo principal; el HTTP que
        // sirve la UI y el puente HID va en otro.
        let serving = Arc::clone(&host);
        std::thread::spawn(move || accept_loop(listener, serving));
        if let Err(e) = ui::run(&url) {
            eprintln!("  webview: {e}");
            eprintln!("  webview: no hay WebView utilizable; abro una ventana de Edge/Chrome");
            launch_app(&url);
        }
        // la ventana manda: cuando se cierre, el proceso termina
        loop {
            std::thread::park();
        }
    }

    if launch {
        open_browser(&url);
    }
    accept_loop(listener, host);
}

fn accept_loop(listener: TcpListener, host: Arc<Host>) {
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let host = Arc::clone(&host);
                std::thread::spawn(move || {
                    let _ = handle(&host, stream);
                });
            }
            Err(e) => eprintln!("connection: {e}"),
        }
    }
}

fn open_browser(url: &str) {
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(windows)]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    let _ = url;
}

// Navegadores de la familia Chromium: en modo --app abren una ventana sin
// pestañas ni barra de direcciones, que es lo que se espera de un configurador.
#[cfg(target_os = "linux")]
const BROWSER_NAMES: &[&str] = &[
    "microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable",
    "chromium", "chromium-browser", "brave-browser", "vivaldi", "vivaldi-stable",
];

// Perfil propio de la ventana: así lo que se lanza es una instancia única y,
// cuando cierras la ventana, este proceso también termina (no queda de fondo).
fn profile_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|base| base.join("s700-host/browser"))
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join("s700-host\\browser"))
    }
}

#[cfg(target_os = "linux")]
fn find_browser() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("S700_BROWSER") {
        return Some(PathBuf::from(explicit));
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in BROWSER_NAMES {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn find_browser() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("S700_BROWSER") {
        return Some(PathBuf::from(explicit));
    }
    let mut candidates = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            candidates.push(base.join("Microsoft\\Edge\\Application\\msedge.exe"));
            candidates.push(base.join("Google\\Chrome\\Application\\chrome.exe"));
            candidates.push(base.join("BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
            candidates.push(base.join("Vivaldi\\Application\\vivaldi.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Abre el configurador en una ventana de aplicación (sin pestañas ni barra de
/// direcciones). Si no hay ningún Chromium a mano, usa el navegador por defecto.
fn launch_app(url: &str) {
    let bin = match find_browser() {
        Some(bin) => bin,
        None => {
            println!("  app window: no Edge/Chrome/Chromium found — opening the default browser");
            open_browser(url);
            return;
        }
    };
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg(format!("--app={url}"))
        .arg("--window-size=1180,880")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-features=msEdgeFirstRunExperience");
    if let Some(dir) = profile_dir() {
        let _ = std::fs::create_dir_all(&dir);
        cmd.arg(format!("--user-data-dir={}", dir.display()));
    }
    match cmd.spawn() {
        Ok(mut child) => {
            println!("  app window: {} (closing it stops this host)", bin.display());
            std::thread::spawn(move || {
                let _ = child.wait();
                std::process::exit(0);
            });
        }
        Err(e) => {
            eprintln!("  app window: cannot run {}: {e}", bin.display());
            open_browser(url);
        }
    }
}

fn handle(host: &Host, mut conn: TcpStream) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 4096];
    // cabecera hasta \r\n\r\n
    loop {
        let n = conn.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&chunk[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > 64 * 1024 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let mut lines = text.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split(' ');
    let method = parts.next().unwrap_or("GET").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let want = lines
        .find_map(|l| {
            let lower = l.to_ascii_lowercase();
            lower.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    let mut body = Vec::new();
    if let Some(at) = find_body_start(&head) {
        body.extend_from_slice(&head[at..]);
    }
    while body.len() < want {
        let n = conn.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&body).to_string();

    match (method.as_str(), path.as_str()) {
        ("GET", "/api/devices") => {
            let mut out = String::from("{\"ok\":true,\"devices\":[");
            for (i, d) in hid::enumerate().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&format!(
                    "{{\"path\":\"{}\",\"name\":\"{}\",\"vid\":{},\"pid\":{}}}",
                    esc(&d.path),
                    esc(&d.name),
                    d.vid,
                    d.pid
                ));
            }
            out.push_str("]}");
            respond(&mut conn, "200 OK", "application/json", out.as_bytes())
        }
        ("GET", "/api/state") => {
            let open = host.dev.lock().map(|g| g.is_some()).unwrap_or(false);
            let name = host
                .dev
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|d| d.name.clone()))
                .unwrap_or_default();
            let out = format!("{{\"ok\":true,\"open\":{open},\"name\":\"{}\"}}", esc(&name));
            respond(&mut conn, "200 OK", "application/json", out.as_bytes())
        }
        ("GET", "/api/permissions") => {
            let out = permissions_json();
            respond(&mut conn, "200 OK", "application/json", out.as_bytes())
        }
        ("POST", "/api/install-rule") => {
            let out = install_rule_json();
            respond(&mut conn, "200 OK", "application/json", out.as_bytes())
        }
        ("POST", "/api/open") => {
            let path = jstr(&body, "path").unwrap_or_default();
            match hid::open(&path) {
                Ok(dev) => {
                    let out = format!(
                        "{{\"ok\":true,\"name\":\"{}\",\"bytes\":{},\"path\":\"{}\"}}",
                        esc(&dev.name),
                        hid::REPORT_BYTES,
                        esc(&dev.path)
                    );
                    if let Ok(mut guard) = host.dev.lock() {
                        *guard = Some(dev);
                    }
                    respond(&mut conn, "200 OK", "application/json", out.as_bytes())
                }
                Err(e) => json_err(&mut conn, &e.to_string()),
            }
        }
        ("POST", "/api/send") => {
            let id = jnum(&body, "id").unwrap_or(7) as u8;
            let data = jints(&body, "data");
            if data.is_empty() {
                return json_err(&mut conn, "el informe va vacío");
            }
            let guard = match host.dev.lock() {
                Ok(g) => g,
                Err(_) => return json_err(&mut conn, "estado interno roto"),
            };
            match guard.as_ref() {
                Some(dev) => match dev.send_feature(id, &data) {
                    Ok(n) => {
                        let out = format!("{{\"ok\":true,\"wrote\":{n}}}");
                        respond(&mut conn, "200 OK", "application/json", out.as_bytes())
                    }
                    Err(e) => json_err(&mut conn, &e.to_string()),
                },
                None => json_err(&mut conn, "el dispositivo no está abierto"),
            }
        }
        ("POST", "/api/recv") => json_err(
            &mut conn,
            "el ratón no contesta a GetFeature: no hay nada que leer (docs/PROTOCOL.md §4)",
        ),
        ("GET", p) => match asset(p) {
            Some((ctype, bytes)) => respond(&mut conn, "200 OK", ctype, bytes),
            None => respond(&mut conn, "404 Not Found", "text/plain", b"no such file"),
        },
        _ => respond(&mut conn, "405 Method Not Allowed", "text/plain", b"no"),
    }
}

fn find_body_start(head: &[u8]) -> Option<usize> {
    head.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// El HTML viaja con el enchufe inyectado: la definición de la API tiene que
/// existir antes de que bridge.js se ejecute.
fn index_html() -> String {
    INDEX.replace(
        "</head>",
        "<script>window.__S700_API__ = \"/api\";</script>\n<script src=\"/bridge.js\"></script>\n</head>",
    )
}

fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    let js = "text/javascript; charset=utf-8";
    let out: (&'static str, &'static [u8]) = match path {
        "/" | "/index.html" => {
            static INDEX_HTML: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
            let bytes = INDEX_HTML.get_or_init(|| index_html().into_bytes());
            return Some(("text/html; charset=utf-8", bytes.as_slice()));
        }
        "/style.css" => ("text/css; charset=utf-8", STYLE.as_bytes()),
        "/app.js" => (js, APP.as_bytes()),
        "/g6.js" => (js, G6.as_bytes()),
        "/core.js" => (js, CORE.as_bytes()),
        "/storage.js" => (js, STORE.as_bytes()),
        "/default_image.js" => (js, IMAGE.as_bytes()),
        "/bridge.js" => (js, BRIDGE.as_bytes()),
        "/mouse.png" => ("image/png", MOUSE_PNG),
        _ => return None,
    };
    Some(out)
}

fn respond(conn: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    conn.write_all(head.as_bytes())?;
    conn.write_all(body)?;
    conn.flush()
}

fn json_err(conn: &mut TcpStream, msg: &str) -> std::io::Result<()> {
    let out = format!("{{\"ok\":false,\"error\":\"{}\"}}", esc(msg));
    respond(conn, "200 OK", "application/json", out.as_bytes())
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn jstr(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let at = body.find(&pat)? + pat.len();
    let rest = body[at..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'u' => {
                    for _ in 0..4 {
                        chars.next();
                    }
                }
                other => out.push(other),
            },
            c => out.push(c),
        }
    }
    None
}

fn jnum(body: &str, key: &str) -> Option<u32> {
    let pat = format!("\"{key}\"");
    let at = body.find(&pat)? + pat.len();
    let rest = body[at..].trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn jints(body: &str, key: &str) -> Vec<u8> {
    let pat = format!("\"{key}\"");
    let at = match body.find(&pat) {
        Some(i) => i + pat.len(),
        None => return Vec::new(),
    };
    let rest = &body[at..];
    let open = match rest.find('[') {
        Some(i) => i + 1,
        None => return Vec::new(),
    };
    let close = match rest[open..].find(']') {
        Some(i) => open + i,
        None => return Vec::new(),
    };
    rest[open..close]
        .split(',')
        .filter_map(|t| t.trim().parse::<u8>().ok())
        .collect()
}
