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
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".to_owned());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("orc workers | orc tell <worker> \"message\"");
        return Ok(());
    }
    let url = env::var("ORCSPACE_URL").map_err(|_| "ORCSPACE_URL is not set".to_owned())?;
    let token = env::var("ORCSPACE_TOKEN").map_err(|_| "ORCSPACE_TOKEN is not set".to_owned())?;

    match command.as_str() {
        "workers" | "who" | "ps" => {
            let response = request(&url, &token, "GET", "/orchestration/workers", None)?;
            println!("{}", format_workers(&response));
        }
        "tell" => {
            let to = args
                .next()
                .ok_or_else(|| "tell needs <worker>".to_owned())?;
            let text = args.collect::<Vec<_>>().join(" ");
            if text.trim().is_empty() {
                return Err("tell needs non-empty text".to_owned());
            }
            let response = request(
                &url,
                &token,
                "POST",
                "/orchestration/workers/tell",
                Some(json!({ "to": to, "text": text })),
            )?;
            let delivery_id = response
                .get("delivery")
                .and_then(|delivery| delivery.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("confirmed");
            println!("delivered to {to} ({delivery_id})");
        }
        other => return Err(format!("unknown command {other}")),
    }
    Ok(())
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
                        let alive = worker
                            .get("alive")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        format!("  {}  [{}]", id, if alive { "running" } else { "exited" })
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
    let (host, port) = parse_http_url(base_url)?;
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nx-orcspace-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
        payload.len()
    );
    let mut stream = TcpStream::connect((host.as_str(), port))
        .map_err(|error| format!("connect control server: {error}"))?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("send request: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("read response: {error}"))?;
    parse_response(&response)
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
    use super::parse_http_url;

    #[test]
    fn parses_loopback_url() {
        assert_eq!(
            parse_http_url("http://127.0.0.1:1234"),
            Ok(("127.0.0.1".to_owned(), 1234))
        );
    }
}
