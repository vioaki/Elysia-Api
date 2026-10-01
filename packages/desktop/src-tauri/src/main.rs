#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod backend;
#[cfg(target_os = "macos")]
mod macos_update;

fn main() {
    app::run();
}
