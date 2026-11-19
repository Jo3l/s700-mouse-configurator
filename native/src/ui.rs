//! Application window: the UI this very process serves, inside a system
//! WebView — WebView2 on Windows, WebKitGTK on Linux — with no external browser,
//! no tabs and no address bar.
//!
//! The page does not change: it is still the one from `web/` and still talks
//! through `web/bridge.js` against the local HTTP (this process opens the HID).

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

/// Opens the window and runs its event loop. It only returns (with an error) if
/// the window or the WebView cannot be created; if all goes well, it ends the
/// process when the window is closed.
pub fn run(url: &str) -> Result<(), String> {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("S700 mouse configurator")
        .with_inner_size(tao::dpi::LogicalSize::new(1180.0, 880.0))
        .build(&event_loop)
        .map_err(boxed)?;

    let builder = WebViewBuilder::new().with_url(url);

    // On Windows and macOS the WebView hangs off the window; on Linux, off its GTK box.
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
        let _ = &webview;   // it stays alive as long as the window does
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    });
}
