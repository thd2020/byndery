//! `git status` for the tree's colours and branch, and files as they are in HEAD.

use crate::paths::{native, normalize};
use serde_json::{json, Map, Value};

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(native(cwd));
    let out = crate::shell::quiet(&mut cmd).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn join(root: &str, rel: &str) -> String {
    normalize(&format!("{root}/{rel}"))
}

fn empty(root: Option<String>) -> Value {
    json!({ "root": root, "branch": null, "ahead": 0, "behind": 0, "files": {}, "ignored": [] })
}

pub fn status(dir: &str) -> Value {
    let Some(top) = git(dir, &["rev-parse", "--show-toplevel"]) else { return empty(None) };
    let root = normalize(top.trim());
    // --ignored=matching reports an ignored directory once instead of every file inside it.
    match git(&root, &["-c", "core.quotepath=false", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal", "--ignored=matching"]) {
        Some(out) => parse(&root, &out),
        None => empty(Some(root)),
    }
}

fn code(xy: &str) -> &'static str {
    if xy.contains('D') {
        "D"
    } else if xy.starts_with('A') {
        "A"
    } else if xy.contains('R') {
        "R"
    } else {
        "M"
    }
}

fn after(r: &str, n: usize) -> String {
    r.splitn(n + 1, ' ').nth(n).unwrap_or("").to_string()
}

pub fn parse(root: &str, out: &str) -> Value {
    let mut branch = Value::Null;
    let (mut ahead, mut behind) = (0i64, 0i64);
    let mut files = Map::new();
    let mut ignored = Vec::new();
    let recs: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < recs.len() {
        let r = recs[i];
        if let Some(b) = r.strip_prefix("# branch.head ") {
            branch = if b == "(detached)" { Value::Null } else { json!(b) };
        } else if let Some(ab) = r.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            ahead = it.next().and_then(|x| x.trim_start_matches('+').parse().ok()).unwrap_or(0);
            behind = it.next().and_then(|x| x.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if r.starts_with('1') {
            let xy = r.split(' ').nth(1).unwrap_or("");
            files.insert(join(root, &after(r, 8)), json!(code(xy)));
        } else if r.starts_with('2') {
            files.insert(join(root, &after(r, 9)), json!("R"));
            i += 1;
        } else if r.starts_with('u') {
            files.insert(join(root, &after(r, 10)), json!("C"));
        } else if let Some(p) = r.strip_prefix("? ") {
            files.insert(join(root, p), json!("U"));
        } else if let Some(p) = r.strip_prefix("! ") {
            ignored.push(json!(join(root, p)));
        }
        i += 1;
    }
    json!({ "root": root, "branch": branch, "ahead": ahead, "behind": behind, "files": files, "ignored": ignored })
}

/// The file as it is in HEAD.
pub fn show(path: &str) -> Option<String> {
    let p = normalize(path);
    let dir = p.rfind('/').map(|i| &p[..i]).filter(|d| !d.is_empty()).unwrap_or(&p).to_string();
    let top = git(&dir, &["rev-parse", "--show-toplevel"])?;
    let root = normalize(top.trim());
    let rel = p.get(root.len() + 1..)?;
    git(&root, &["show", &format!("HEAD:{rel}")])
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn porcelain() {
        let out = "# branch.head main\0# branch.ab +2 -1\01 .M N... 100644 100644 100644 a b src/a b.ts\0? new.txt\0! node_modules/\02 R. N... 100644 100644 100644 a b R100 to.ts\0from.ts\0";
        let s = parse("C:/r", out);
        assert_eq!(s["branch"], "main");
        assert_eq!(s["ahead"], 2);
        assert_eq!(s["behind"], 1);
        assert_eq!(s["files"]["C:/r/src/a b.ts"], "M");
        assert_eq!(s["files"]["C:/r/new.txt"], "U");
        assert_eq!(s["files"]["C:/r/to.ts"], "R");
        assert_eq!(s["ignored"][0], "C:/r/node_modules");
    }
}
