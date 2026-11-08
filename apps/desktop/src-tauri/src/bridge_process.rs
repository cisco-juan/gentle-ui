//! The bundled bridge process: start it, learn its port and token, and stop it on quit.
//!
//! A packaged app carries Node and the bridge inside its resources (`docs/packaging.md`), because the
//! user has no Node and the UI cannot open a socket to a port nobody told it about. So the shell owns
//! the process: spawn it, read the one handshake line, answer the webview, and kill the child when the
//! window closes.
//!
//! Development is the opposite case: `scripts/dev.mjs` already runs the bridge on port 7787 with token
//! `dev`, so a debug build never spawns a second one and the frontend keeps its dev URL.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// How long the bridge gets to print its handshake before the shell calls it broken.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The bridge's one stdout line: `{"event":"ready","port":47831,"token":"…"}`.
#[derive(Deserialize)]
struct Handshake {
    event: String,
    port: u16,
    token: String,
}

/// What the webview needs to open its socket. Serialised straight out of the `bridge_endpoint` command.
#[derive(Clone, Debug, Serialize)]
pub struct BridgeEndpoint {
    port: u16,
    token: String,
}

/// Lifecycle of the child from the webview's point of view.
#[derive(Debug)]
enum Status {
    /// Spawned, handshake outstanding.
    Starting,
    /// Listening, with the credentials it printed.
    Ready(BridgeEndpoint),
    /// Not going to work, carrying the message the UI shows.
    Failed(String),
}

impl Status {
    fn is_starting(&self) -> bool {
        matches!(self, Status::Starting)
    }
}

/// Managed state: the handshake result the command answers with, plus the child it describes.
///
/// The child sits behind its own lock so a quit can take it while another thread is waiting for the
/// handshake. Nothing here panics on a poisoned lock: a broken bridge must degrade into a message.
pub struct BridgeState {
    status: Mutex<Status>,
    changed: Condvar,
    child: Mutex<Option<Child>>,
}

impl BridgeState {
    fn with_status(status: Status) -> Self {
        Self {
            status: Mutex::new(status),
            changed: Condvar::new(),
            child: Mutex::new(None),
        }
    }

    /// A build that never owns a bridge, so the command answers instead of waiting out the timeout.
    fn unwired(message: impl Into<String>) -> Self {
        Self::with_status(Status::Failed(message.into()))
    }

    fn starting() -> Self {
        Self::with_status(Status::Starting)
    }

    fn status(&self) -> MutexGuard<'_, Status> {
        self.status.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn child(&self) -> MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn set(&self, status: Status) {
        *self.status() = status;
        self.changed.notify_all();
    }

    fn fail(&self, message: String) {
        eprintln!("bridge: {message}");
        self.set(Status::Failed(message));
    }

    fn ready(&self, endpoint: BridgeEndpoint) {
        eprintln!("bridge: listening on port {}", endpoint.port);
        self.set(Status::Ready(endpoint));
    }

    fn attach(&self, process: Child) {
        *self.child() = Some(process);
    }

    /// Wait for the handshake, bounded, and answer what the webview can display.
    ///
    /// The frontend asks as soon as it boots, which is usually before Node has finished starting, so
    /// this waits instead of failing the first call. `HANDSHAKE_TIMEOUT` bounds the wait either way.
    fn endpoint(&self) -> Result<BridgeEndpoint, String> {
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        let mut status = self.status();

        while status.is_starting() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let (next, waited) = self
                .changed
                .wait_timeout(status, left)
                .unwrap_or_else(|poison| poison.into_inner());
            status = next;
            if waited.timed_out() {
                break;
            }
        }

        match &*status {
            Status::Ready(endpoint) => {
                let endpoint = endpoint.clone();
                drop(status);
                // The bridge can still die after it reported a port; the UI must hear about that too.
                self.running(endpoint)
            }
            Status::Failed(message) => Err(message.clone()),
            Status::Starting => Err(format!(
                "the bridge did not report its port within {} s",
                HANDSHAKE_TIMEOUT.as_secs()
            )),
        }
    }

    /// Reject an endpoint whose child is gone, so a dead bridge never looks usable.
    fn running(&self, endpoint: BridgeEndpoint) -> Result<BridgeEndpoint, String> {
        let mut child = self.child();
        match child.as_mut() {
            Some(process) => match process.try_wait() {
                Ok(None) => Ok(endpoint),
                Ok(Some(status)) => Err(format!("the bridge exited ({status})")),
                Err(err) => Err(format!("cannot read the bridge state: {err}")),
            },
            None => Err("the bridge is not running".to_string()),
        }
    }

    /// Terminate the child if it still lives. Idempotent: window close and app exit both call it.
    fn stop(&self) {
        let Some(mut process) = self.child().take() else {
            return;
        };
        if !matches!(process.try_wait(), Ok(Some(_))) {
            let _ = process.kill();
        }
        let _ = process.wait();
        eprintln!("bridge: stopped");
    }
}

/// The state the app boots with.
///
/// A debug build (`tauri dev`, a plain `cargo run`) never owns a bridge, and a release build that
/// cannot find its bundle should say so instead of stalling the first `bridge_endpoint` call for ten
/// seconds.
pub fn initial_state() -> BridgeState {
    if cfg!(debug_assertions) {
        BridgeState::unwired("development build: scripts/dev.mjs owns the bridge")
    } else {
        BridgeState::starting()
    }
}

/// Spawn the bundled bridge, in the background, once the app is set up.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        eprintln!("bridge: development build, the dev server owns the bridge; not spawning");
        return;
    }

    let state = app.state::<BridgeState>();
    let bridge = match app.path().resource_dir() {
        Ok(resources) => resources.join("bridge"),
        Err(err) => {
            state.fail(format!("cannot resolve the resource directory: {err}"));
            return;
        }
    };
    let node = bridge.join(if cfg!(windows) { "node.exe" } else { "node" });
    let entry = bridge.join("app").join("dist").join("main.js");
    if !node.exists() || !entry.exists() {
        state.fail(format!("the bundled bridge is missing from {}", bridge.display()));
        return;
    }
    drop(state);

    // Node plus the Pi harness takes long enough that blocking setup would show a frozen window.
    let handle = app.clone();
    std::thread::spawn(move || spawn(handle, node, entry));
}

/// Start the child, keep its handle, then wait for the handshake.
fn spawn(app: AppHandle, node: PathBuf, entry: PathBuf) {
    let mut process = match launch(&node, &entry) {
        Ok(process) => process,
        Err(err) => {
            app.state::<BridgeState>()
                .fail(format!("cannot start {}: {err}", node.display()));
            return;
        }
    };

    let stdout = process.stdout.take();
    app.state::<BridgeState>().attach(process);

    match handshake(stdout) {
        Ok(endpoint) => app.state::<BridgeState>().ready(endpoint),
        Err(message) => {
            let state = app.state::<BridgeState>();
            state.fail(message);
            // A bridge we never learned the token of is of no use to anyone; do not leave it running.
            state.stop();
        }
    }
}

/// `node app/dist/main.js --port 0`: the OS picks a free port, the bridge generates its own token.
fn launch(node: &Path, entry: &Path) -> std::io::Result<Child> {
    Command::new(node)
        .arg(entry)
        .args(["--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Read the handshake line, bounded by `HANDSHAKE_TIMEOUT`.
///
/// The reader lives in its own thread because reading a pipe blocks and cannot be given a deadline.
/// It keeps going after the handshake on purpose: the child writes its logs to stdout, and closing the
/// pipe under it would turn the next write into `EPIPE` and kill the bridge.
fn handshake(stdout: Option<ChildStdout>) -> Result<BridgeEndpoint, String> {
    let Some(stdout) = stdout else {
        return Err("the bridge stdout was not captured".to_string());
    };

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut reported = false;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    if !reported {
                        let _ = sender.send(Err("the bridge exited before it reported a port".to_string()));
                    }
                    return;
                }
                Ok(_) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if reported {
                        eprintln!("bridge: {line}");
                        continue;
                    }
                    reported = true;
                    let _ = sender.send(parse(line));
                }
                Err(err) => {
                    if reported {
                        eprintln!("bridge: cannot read its output: {err}");
                    } else {
                        let _ = sender.send(Err(format!("cannot read the bridge handshake: {err}")));
                    }
                    return;
                }
            }
        }
    });

    match receiver.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "the bridge did not report its port within {} s",
            HANDSHAKE_TIMEOUT.as_secs()
        )),
    }
}

/// Turn the handshake line into an endpoint, or into the reason it is not one.
fn parse(line: &str) -> Result<BridgeEndpoint, String> {
    let ready: Handshake = serde_json::from_str(line)
        .map_err(|err| format!("unexpected bridge handshake ({err}): {line}"))?;
    if ready.event != "ready" {
        return Err(format!("unexpected bridge event: {line}"));
    }
    Ok(BridgeEndpoint {
        port: ready.port,
        token: ready.token,
    })
}

/// Terminate the bridge on the way out, whatever triggered the exit.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<BridgeState>() {
        state.stop();
    }
}

/// The one call the webview makes: give me the port and the token.
///
/// Answers an error the UI can display when the bundle is missing, the bridge died, or the handshake
/// timed out. It never panics and never falls back to a guessed port.
#[tauri::command]
pub fn bridge_endpoint(state: tauri::State<'_, BridgeState>) -> Result<BridgeEndpoint, String> {
    state.endpoint()
}
