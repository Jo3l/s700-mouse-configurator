//! Ventana de la aplicación: la UI que sirve este mismo proceso, dentro de un
//! WebView del sistema — WebView2 en Windows, WebKitGTK en Linux — sin navegador
//! externo, sin pestañas y sin barra de direcciones.
//!
//! La página no cambia: sigue siendo la de `web/` y sigue hablando por
//! `web/bridge.js` contra el HTTP local (el HID lo abre este proceso).

use std::error::Error;

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

fn boxed(e: impl Error + Send + Sync + 'static) -> String {
    e.to_string()
}

/// Abre la ventana y corre su bucle de eventos. Sólo vuelve (con error) si no
/// se puede crear la ventana o el WebView; si todo va bien, termina el proceso
/// al cerrarla.
pub fn run(url: &str) -> Result<(), String> {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("S700 mouse configurator")
        .with_inner_size(tao::dpi::LogicalSize::new(1180.0, 880.0))
        .build(&event_loop)
        .map_err(boxed)?;

    let builder = WebViewBuilder::new().with_url(url);

    // En Windows y macOS el WebView cuelga de la ventana; en Linux, de su caja GTK.
    #[cfg(target_os = "windows")]
    let webview = builder.build(&window).map_err(boxed)?;

    #[cfg(not(target_os = "windows"))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .ok_or_else(|| "gtk: the window has no default box".to_string())?;
        builder.build_gtk(vbox).map_err(boxed)?
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &webview;   // se queda vivo mientras dure la ventana
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    });
}
