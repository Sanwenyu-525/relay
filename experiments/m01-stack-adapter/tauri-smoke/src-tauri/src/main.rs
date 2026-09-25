fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("M01 Tauri compatibility probe failed to start");
}
