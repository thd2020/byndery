//! Credentials never written to disk: the same shapes as src/shared/history.ts,
//! used for shell history imported from files (live commands are redacted in
//! the renderer before they arrive).

use regex::Regex;
use std::sync::OnceLock;

pub const REDACTED: &str = "‹redacted›";

fn patterns() -> &'static (Vec<Regex>, Regex) {
    static P: OnceLock<(Vec<Regex>, Regex)> = OnceLock::new();
    P.get_or_init(|| {
        let list = [
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
            r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
            r"\bgithub_pat_[A-Za-z0-9_]{50,}\b",
            r"\bglpat-[A-Za-z0-9_-]{20,}\b",
            r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b",
            r"\b[rs]k_live_[A-Za-z0-9]{20,}\b",
            r"\bnpm_[A-Za-z0-9]{36}\b",
            r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b",
            r"\bAIza[0-9A-Za-z_-]{35}\b",
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            r"\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b",
        ];
        let assign = Regex::new(r#"(?i)((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*\s*(?:=|:|\s)\s*)(["']?)([^\s"']{4,})(["']?)"#).unwrap();
        (list.iter().map(|p| Regex::new(p).unwrap()).collect(), assign)
    })
}

pub fn redact(text: &str) -> String {
    let (list, assign) = patterns();
    let mut out = text.to_string();
    for re in list {
        out = re.replace_all(&out, REDACTED).into_owned();
    }
    assign.replace_all(&out, format!("${{1}}${{2}}{REDACTED}${{4}}").as_str()).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets() {
        assert_eq!(redact("export TOKEN=abcd1234"), format!("export TOKEN={REDACTED}"));
        assert_eq!(redact("curl -H 'x' --password \"hunter22\""), format!("curl -H 'x' --password \"{REDACTED}\""));
        assert!(redact("key AKIAABCDEFGHIJKLMNOP end").contains(REDACTED));
        assert_eq!(redact("ls -la"), "ls -la");
    }
}
