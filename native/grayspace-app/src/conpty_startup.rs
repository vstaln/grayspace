#[derive(Default)]
pub struct StartupFilter {
    finished: bool,
    pending: Vec<u8>,
    scanned: usize,
}

impl StartupFilter {
    pub fn process(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        if self.finished {
            return (bytes.to_vec(), Vec::new());
        }
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let (mut output, mut replies) = (Vec::new(), Vec::new());
        let mut index = 0;
        while index < data.len() {
            if data[index] != 0x1b {
                if data[index] > 0x20 && data[index] != 0x7f {
                    self.finished = true;
                    output.extend_from_slice(&data[index..]);
                    return (output, replies);
                }
                output.push(data[index]);
                index += 1;
                continue;
            }
            let Some(length) = sequence_length(&data[index..]) else {
                if data.len() - index > 512 {
                    self.finished = true;
                    output.extend_from_slice(&data[index..]);
                } else {
                    self.pending.extend_from_slice(&data[index..]);
                }
                return (output, replies);
            };
            let sequence = &data[index..index + length];
            let answer: &[u8] = match sequence {
                b"\x1b[c" | b"\x1b[0c" => b"\x1b[?61;6;22c",
                b"\x1b[>c" | b"\x1b[>0c" => b"\x1b[>0;10;1c",
                b"\x1b[=c" | b"\x1b[=0c" => b"\x1bP!|00000000\x1b\\",
                b"\x1b[6n" => b"\x1b[1;1R",
                b"\x1b[?6n" => b"\x1b[?1;1;1R",
                _ => b"",
            };
            if answer.is_empty() {
                output.extend_from_slice(sequence);
            } else {
                replies.extend_from_slice(answer);
            }
            index += length;
        }
        self.scanned += data.len();
        self.finished = self.scanned >= 4096;
        (output, replies)
    }

    pub fn finish(&mut self) -> Vec<u8> {
        self.finished = true;
        std::mem::take(&mut self.pending)
    }
}

fn sequence_length(bytes: &[u8]) -> Option<usize> {
    match *bytes.get(1)? {
        b'[' => bytes[2..]
            .iter()
            .position(|byte| (0x40..=0x7e).contains(byte))
            .map(|n| n + 3),
        b']' | b'P' | b'^' | b'_' | b'X' => {
            for index in 2..bytes.len() {
                if bytes[index] == 7 {
                    return Some(index + 1);
                }
                if bytes[index..].starts_with(b"\x1b\\") {
                    return Some(index + 2);
                }
            }
            None
        }
        _ => bytes[1..]
            .iter()
            .position(|byte| !(0x20..=0x2f).contains(byte))
            .map(|n| n + 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_queries_and_titles_work_at_every_transport_split() {
        let probe = b"\x1b]0;cmd.exe\x07\x1b[c\x1b[6n\x1b[>c\x1b[?6n\x1b[=c";
        for split in 0..=probe.len() {
            let mut filter = StartupFilter::default();
            let (mut output, mut replies) = filter.process(&probe[..split]);
            let (tail, answers) = filter.process(&probe[split..]);
            output.extend(tail);
            replies.extend(answers);
            assert_eq!(output, b"\x1b]0;cmd.exe\x07");
            assert_eq!(
                replies,
                b"\x1b[?61;6;22c\x1b[1;1R\x1b[>0;10;1c\x1b[?1;1;1R\x1bP!|00000000\x1b\\"
            );
            assert_eq!(
                filter.process(b"prompt>\x1b[c"),
                (b"prompt>\x1b[c".to_vec(), vec![])
            );
        }
    }

    #[test]
    fn malformed_preamble_and_eof_do_not_hold_output_forever() {
        let mut filter = StartupFilter::default();
        let runaway = [b"\x1b[".as_slice(), &vec![b'1'; 600]].concat();
        assert_eq!(filter.process(&runaway).0, runaway);
        let mut filter = StartupFilter::default();
        assert!(filter.process(b"\x1b[").0.is_empty());
        assert_eq!(filter.finish(), b"\x1b[");
    }
}
