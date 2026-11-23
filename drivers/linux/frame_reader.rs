// frame_reader.rs
// Simple Rust tool to open a shared-memory file and print its size. Useful for
// verifying the desktop client is writing frames correctly on Linux.

use std::env;
use std::fs::File;
use std::io::Read;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <shm_path>", args[0]);
        std::process::exit(1);
    }
    let path = &args[1];
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    let mut buf = Vec::with_capacity(size as usize);
    file.read_to_end(&mut buf)?;
    println!("Read {} bytes from {}", size, path);
    Ok(())
}
