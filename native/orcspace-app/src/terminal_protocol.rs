#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Mode(u16, bool),
    Cursor(u16),
    Reset,
    Status(u16, bool),
    Attributes,
}

#[derive(Default)]
pub struct Decoder {
    parser: vte::Parser,
}

#[derive(Default)]
struct Commands(Vec<Control>);

impl vte::Perform for Commands {
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        if ignore {
            return;
        }
        let first = params
            .iter()
            .next()
            .and_then(|p| p.first())
            .copied()
            .unwrap_or(0);
        match (intermediates, action) {
            (b"?", 'h' | 'l') => {
                for param in params.iter().filter(|p| p.len() == 1) {
                    self.0.push(Control::Mode(param[0], action == 'h'));
                }
            }
            (b" ", 'q') if first <= 6 => self.0.push(Control::Cursor(first)),
            (b"" | b"?", 'n') => self.0.push(Control::Status(first, intermediates == b"?")),
            (b"", 'c') if first == 0 => self.0.push(Control::Attributes),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        if !ignore && intermediates.is_empty() && byte == b'c' {
            self.0.push(Control::Reset);
        }
    }
}

impl Decoder {
    pub fn advance(&mut self, bytes: &[u8]) -> Vec<Control> {
        let mut commands = Commands::default();
        self.parser.advance(&mut commands, bytes);
        commands.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_and_combined_modes_preserve_order() {
        let mut parser = Decoder::default();
        assert!(parser.advance(b"\x1b[?12;10").is_empty());
        assert_eq!(
            parser.advance(b"04l\x1b[5 q\x1b[?12h"),
            vec![
                Control::Mode(12, false),
                Control::Mode(1004, false),
                Control::Cursor(5),
                Control::Mode(12, true),
            ]
        );
        assert!(parser.advance(b"plain").is_empty());
    }

    #[test]
    fn string_payloads_do_not_change_terminal_modes() {
        let mut parser = Decoder::default();
        assert!(parser
            .advance(b"\x1bPtext ?12h\x1b\\\x1b]0;title ?12h\x07")
            .is_empty());
        assert_eq!(parser.advance(b"\x1bc"), vec![Control::Reset]);
    }
}
