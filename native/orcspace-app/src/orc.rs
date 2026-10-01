use serde_json::{json, Value};
use std::{
    env,
    io::{Read, Write},
    net::TcpStream,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("orc: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let argv: Vec<String> = env::args().skip(1).collect();
    let parsed = orcspace_app::cli::Args::parse(&argv);
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".to_owned());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("orc workers | orc tell <worker> \"message\" | orc worker-read <terminal>\nOrchestration commands: run-create, task-create, task-list, check, reply, done");
        return Ok(());
    }
    let url = env::var("ORCSPACE_SOCKET_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| env::var("ORCSPACE_URL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| orcspace_app::ipc::socket_path(orcspace_app::ipc::is_dev_environment()));
    let token = env::var("ORCSPACE_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string(orcspace_app::ipc::control_token_path()).ok())
        .ok_or("No control token; start OrcSpace first")?;
    let token = token.trim().to_owned();
    if token.contains(['\r', '\n']) {
        return Err("Invalid control token".into());
    }

    match command.as_str() {
        "workers" | "who" | "ps" => {
            let response = request(&url, &token, "GET", "/orchestration/workers", None)?;
            println!(
                "{}",
                if parsed.flag("json") {
                    response.to_string()
                } else {
                    format_workers(&response)
                }
            );
        }
        "tell" => {
            let body = tell_body(&parsed)?;
            let to = body["to"].as_str().unwrap();
            let response = request(
                &url,
                &token,
                "POST",
                "/orchestration/workers/tell",
                Some(body.clone()),
            )?;
            let delivery_id = response
                .get("delivery")
                .and_then(|delivery| delivery.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("confirmed");
            if parsed.flag("json") {
                println!("{response}");
            } else {
                println!("delivered to {to} ({delivery_id})");
            }
        }
        "worker-read" | "logs" | "tail" => {
            let id = parsed
                .pick(&["to", "id"])
                .or_else(|| parsed.positionals().get(1).cloned())
                .or_else(|| env::var("ORCSPACE_TERMINAL_ID").ok())
                .ok_or("worker-read needs a terminal id")?;
            let response = request(
                &url,
                &token,
                "GET",
                &format!("/terminal/{}/output", encode(&id)),
                None,
            )?;
            if parsed.flag("json") {
                println!("{response}");
            } else {
                println!(
                    "{}",
                    response.get("output").and_then(Value::as_str).unwrap_or("")
                );
            }
        }
        other => {
            let argv: Vec<String> = env::args().skip(1).collect();
            let parsed = orcspace_app::cli::Args::parse(&argv);
            let plan = orcspace_app::cli::plan(other, &parsed).map_err(|e| e.to_string())?;
            let mut path = plan.path;
            if !plan.query.is_empty() {
                path.push('?');
                path.push_str(
                    &plan
                        .query
                        .iter()
                        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
                        .collect::<Vec<_>>()
                        .join("&"),
                );
            }
            let response = request(
                &url,
                &token,
                &plan.method,
                &path,
                (!plan.body.is_null()).then_some(plan.body),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&response).map_err(|e| e.to_string())?
            );
        }
    }
    Ok(())
}

fn tell_body(parsed: &orcspace_app::cli::Args) -> Result<Value, String> {
    let mut positional = parsed.positionals().iter().skip(1);
    let to = parsed
        .pick(&["to", "worker"])
        .or_else(|| positional.next().cloned())
        .ok_or("tell needs <worker>")?;
    let text = parsed
        .pick(&["text", "message", "body"])
        .unwrap_or_else(|| positional.cloned().collect::<Vec<_>>().join(" "));
    let images = if let Some(image) = parsed.pick(&["image"]) {
        vec![image]
    } else if let Some(images) = parsed.pick(&["images"]) {
        serde_json::from_str::<Vec<String>>(&images).unwrap_or_else(|_| {
            images
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
    } else {
        Vec::new()
    };
    if text.trim().is_empty() && images.is_empty() {
        return Err("tell needs non-empty text".into());
    }
    Ok(json!({ "to": to, "text": text, "images": images }))
}

fn format_workers(response: &Value) -> String {
    response
        .get("workers")
        .and_then(Value::as_array)
        .map(|workers| {
            if workers.is_empty() {
                "  (no terminals open)".to_owned()
            } else {
                workers
                    .iter()
                    .map(|worker| {
                        let id = worker.get("id").and_then(Value::as_str).unwrap_or("?");
                        // Names beat ids for addressing, so the name leads and
                        // the id follows only where they differ.
                        let name = worker.get("name").and_then(Value::as_str).unwrap_or(id);
                        let alive = worker
                            .get("alive")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let status = if alive { "running" } else { "exited" };
                        if name == id {
                            format!("  {name}  [{status}]")
                        } else {
                            format!("  {name}  ({id})  [{status}]")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        })
        .unwrap_or_else(|| response.to_string())
}

fn request(
    base_url: &str,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut stream: Box<dyn Transport> = if base_url.starts_with("http://") {
        let (host, port) = parse_http_url(base_url)?;
        let stream = TcpStream::connect((host.as_str(), port))
            .map_err(|e| format!("connect control server: {e}"))?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        Box::new(stream)
    } else {
        local_transport(base_url)?
    };
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-orcspace-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
        payload.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("send request: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut response)
        .map_err(|error| format!("read response: {error}"))?;
    if response.len() > 16 * 1024 * 1024 {
        return Err("Control response exceeds 16 MB".into());
    }
    parse_response(&response)
}

trait Transport: Read + Write {}
impl<T: Read + Write> Transport for T {}

#[cfg(windows)]
fn local_transport(path: &str) -> Result<Box<dyn Transport>, String> {
    if !path.starts_with(r"\\.\pipe\") {
        return Err("Control endpoint must be a local named pipe".into());
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map(|file| Box::new(file) as Box<dyn Transport>)
        .map_err(|e| format!("connect control pipe: {e}"))
}

#[cfg(unix)]
fn local_transport(path: &str) -> Result<Box<dyn Transport>, String> {
    let stream = std::os::unix::net::UnixStream::connect(path)
        .map_err(|e| format!("connect control socket: {e}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    Ok(Box::new(stream))
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn parse_http_url(url: &str) -> Result<(String, u16), String> {
    let authority = url
        .strip_prefix("http://")
        .ok_or_else(|| "ORCSPACE_URL must use http://".to_owned())?
        .split('/')
        .next()
        .unwrap_or_default();
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "ORCSPACE_URL must include a port".to_owned())?;
    let port = port
        .parse::<u16>()
        .map_err(|error| format!("invalid control server port: {error}"))?;
    Ok((host.to_owned(), port))
}

fn parse_response(response: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(response);
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "invalid control server response".to_owned())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("500");
    let json: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({ "body": body }));
    if status.starts_with('2') {
        Ok(json)
    } else {
        Err(json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("control server request failed")
            .to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_http_url, tell_body};

    #[test]
    fn tell_preserves_positionals_and_flag_targets() {
        for args in [
            vec!["tell", "backend", "hello", "world"],
            vec!["tell", "--to", "backend", "hello world"],
            vec!["tell", "--json", "--to=backend", "hello", "world"],
            vec!["tell", "backend", "--text", "hello world"],
        ] {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            let body = tell_body(&orcspace_app::cli::Args::parse(&args)).unwrap();
            assert_eq!(body["to"], "backend");
            assert_eq!(body["text"], "hello world");
        }
    }

    #[test]
    fn tell_accepts_image_only_and_literal_flags_after_double_dash() {
        let parse = |args: &[&str]| {
            tell_body(&orcspace_app::cli::Args::parse(
                &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ))
        };
        assert_eq!(
            parse(&["tell", "backend", "--", "--help", "please"]).unwrap()["text"],
            "--help please"
        );
        assert_eq!(
            parse(&["tell", "--to", "backend", "--image", "a b.png"]).unwrap()["images"][0],
            "a b.png"
        );
        assert!(parse(&["tell", "backend"]).is_err());
    }

    #[test]
    fn parses_loopback_url() {
        assert_eq!(
            parse_http_url("http://127.0.0.1:1234"),
            Ok(("127.0.0.1".to_owned(), 1234))
        );
    }
}
