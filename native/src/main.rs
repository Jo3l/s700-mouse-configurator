//! Host nativo del configurador S700.
//!
//! Sirve la UI de web/ desde dentro del binario (127.0.0.1, sólo local), abre
//! el navegador y hace de puente con el HID del ratón. La página no cambia: en
//! lugar de navigator.hid usa el enchufe de web/bridge.js, que este proceso
//! inyecta al servir el HTML.
//!
//! Sin dependencias externas: HTTP a mano sobre std, hidraw en Linux e hid.dll
//! en Windows.

mod hid;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

const INDEX: &str = include_str!("../../web/index.html");
const STYLE: &str = include_str!("../../web/style.css");
const APP: &str = include_str!("../../web/app.js");
const G6: &str = include_str!("../../web/g6.js");
const CORE: &str = include_str!("../../web/core.js");
const STORE: &str = include_str!("../../web/storage.js");
const DEBUGJS: &str = include_str!("../../web/debug.js");
const IMAGE: &str = include_str!("../../web/default_image.js");
const BRIDGE: &str = include_str!("../../web/bridge.js");
const MOUSE_PNG: &[u8] = include_bytes!("../../web/mouse.png");

const DEFAULT_PORT: u16 = 8760;

struct Host {
    dev: Mutex<Option<hid::Device>>,
}

fn main() {
    let mut port = DEFAULT_PORT;
    let mut launch = true;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                if let Some(v) = args.get(i + 1) {
                    match v.parse::<u16>() {
                        Ok(p) => port = p,
                        Err(_) => {
                            eprintln!("puerto inválido: {v}");
                            std::process::exit(2);
                        }
                    }
                    i += 1;
                }
            }
            "--no-open" => launch = false,
            "--list" => {
                let devs = hid::enumerate();
                if devs.is_empty() {
                    println!("no hay interfaces con el vendor page 0xFF00 a la vista");
                }
                for d in devs {
                    println!("{}\t{:04x}:{:04x}\t{}", d.path, d.vid, d.pid, d.name);
                }
                return;
            }
            "-h" | "--help" => {
                help();
                return;
            }
            other => {
                eprintln!("no entiendo «{other}»");
                help();
                std::process::exit(2);
            }
        }
        i += 1;
    }
    serve(port, launch);
}

fn help() {
    println!(
        "s700-host [--port N] [--no-open] [--list]\n\
         \n\
           --port N    puerto local (por defecto {DEFAULT_PORT}); fíjalo para que el\n\
                       almacenamiento del navegador (localStorage) siga siendo el mismo\n\
           --no-open   no abrir el navegador\n\
           --list      enumerar las interfaces HID del ratón y salir"
    );
}

fn serve(port: u16, launch: bool) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("no puedo escuchar en 127.0.0.1:{port}: {e}");
            eprintln!("prueba con --port {0}", port.saturating_add(1).max(1024));
            std::process::exit(1);
        }
    };
    let url = format!("http://127.0.0.1:{port}/");
    let host = Arc::new(Host { dev: Mutex::new(None) });

    println!("s700-host · {url}");
    let devs = hid::enumerate();
    if devs.is_empty() {
        println!("  ratón: no encontrado (0 interfaces 0xFF00) — conéctalo y pulsa Connect");
    } else {
        for d in &devs {
            println!("  ratón: {} {:04x}:{:04x} {}", d.path, d.vid, d.pid, d.name);
        }
    }
    println!("  Ctrl+C para parar");

    if launch {
        open_browser(&url);
    }
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let host = Arc::clone(&host);
                std::thread::spawn(move || {
                    let _ = handle(&host, stream);
                });
            }
            Err(e) => eprintln!("conexión: {e}"),
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
        "/debug.js" => (js, DEBUGJS.as_bytes()),
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
