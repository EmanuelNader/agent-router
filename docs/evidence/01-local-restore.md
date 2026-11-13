# Local workspace restore

Recorded 2026-11-13 on Linux x86_64. This file is part of the commit that records the results below. This is a single-host checkpoint and restore of a quiesced OpenCode workspace. It is not a cloud migration, a model-memory test, or a claim that pending prompts survive.

| Check | Observed result |
| --- | --- |
| Runtime | Node v24.22.3, pnpm 11.25.0, restic 0.19.1 compiled with go1.26.4 |
| `pnpm check` | PASS: typecheck and 39 tests |
| Encrypted checkpoint | PASS: restic 0.19.1 repository, password file outside the Git checkout |
| Plaintext in repository | PASS: fixture phrases absent from repository bytes |
| Fresh-directory restore | PASS: file hashes, executable script, hidden and untracked files, rename, Git HEAD/index/status |
| Cache exclusion | PASS: `node_modules` and `.cache` absent after restore |
| Fresh OpenCode process | PASS: same session id, settled shell output, target directory binding, second shell command accepted |
| Tampered manifest | PASS: refused, partial directory removed |
| Corrupted pack | PASS: refused after `restic check --read-data` |
| Wrong version | PASS: format 2, agent 9.9.9, architecture `sparc`, runtime digest, and restic 0.0.0 refused before a workspace was left behind |
| Incomplete snapshot | PASS: missing session export and missing snapshot id refused |
| Symlink and nested repository | PASS: symlink not checkpointed; repository inside the workspace refused |
| Model inference | UNTESTED |
| Pending prompt inbox | NOT TRANSFERRED |
| Cross-host and cloud restore | UNTESTED |

## Gate

The restored fixture matched the saved file receipt and Git state. A new OpenCode process imported the saved session, returned the original shell output, and accepted another shell command. The repository upload alone did not satisfy the check: restore verifies hashes and the session digest, and the process proof re-exports the history.

## Reproduce

From the repository root, with Node 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
bash scripts/install-restic.sh
export PATH="$HOME/.local/bin:$PATH"
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
pnpm agent:restore
```

`scripts/install-restic.sh` downloads restic 0.19.1 and checks the upstream SHA256SUMS digest for the host platform. The restore script writes a mode `0600` password file under the system temp directory and deletes it afterward. It does not print the password, the session text, or the key path.

## Versions and timings

Observed at 2026-11-13T10:28:27Z:

```text
Linux 6.12.113+ x86_64
node v24.22.3
pnpm 11.25.0
restic 0.19.1 compiled with go1.26.4 on linux/amd64
```

| Command | Elapsed | Exit |
| --- | --- | --- |
| `pnpm check` | 41.7s | 0 |
| `pnpm agent:probe` | 4.290s | 0 |
| `pnpm agent:roundtrip` | 4.793s | 0 |
| `pnpm agent:restore` | 10.911s | 0 |

Inside `agent:restore`, capture took 3500 ms, restore 2072 ms, and the fresh OpenCode process became ready and imported the session in 235 ms. The scenario file `tests/scenarios/local-restore.test.ts` passed 7 tests in 37.43s. The full `pnpm check` run passed 11 files and 39 tests in 38.32s.

## What is checkpointed

The adapter exports settled history, then stops the source process. Capture hashes the workspace with `hashWorkspace`, omitting `.git` from the receipt and omitting `node_modules` and `.cache` from both the receipt and the backup. It copies the remaining tree, including `.git`, plus `session.json` into a staging directory and runs `restic backup`. The manifest is format version 1 and records the workspace id, architecture, platform, OpenCode version, a runtime digest, the restic snapshot id, the file receipt, the session id, and the session sha256.

The runtime digest is sha256 of `node=<process.version>`, `agent=2.2.7`, and `restic=0.19.1`. No container image is built in this milestone. Consistency is `agent-stopped-session-exported`.

Source and target file receipts were equal:

| Path | Executable | sha256 |
| --- | --- | --- |
| `.gitignore` | false | `af4ab05e427b8408f81adcadfbc042fc81f69e62cc750bece8b8bde1152886ee` |
| `.workspace-note` | false | `ea512d015314550ca448655a76011ef00affae231a7d7db95956214901f5c769` |
| `PROJECT.md` | false | `d42749a1197647f667c05ef769b7ca6efd59f3567cb23c8923fbe23a2e677d55` |
| `notes.txt` | false | `28c6a3c6ddbf69cd861036f1f2a680de80d618b382d03bf939320ce31ed3f8ca` |
| `scripts/check.sh` | true | `7dfa6db94c265e31e910edd896afae736a649f9c33499e29a1f59b55b83d6b64` |
| `src/message.txt` | false | `f778c15db55770eb42e069e6e9cdd912b9955cb825d663ef61fa984b7f67889e` |

`scripts/check.sh` printed `fixture-ok`. `PROJECT.md` replaced `README.md`. `notes.txt` and `.workspace-note` were present. After the checkpoint was taken, changing `notes.txt` in the source did not change the restored copy. Git HEAD, index, and porcelain status matched. `node_modules/skipped.txt` and `.cache/tmp` were not restored.

The repository did not contain `router-history-fixture`, `keep this hidden note`, `unfinished work survives migration`, or `dependency cache stays behind`. A unit test also started a stand-in restic binary and checked that the password value was neither an argument nor an environment variable. A group-readable key file is refused before a process starts.

The fresh process kept session id and the message list from the export, with the session location set to the restored directory. It then ran `printf 'router-history-continued\n'` and a later export contained both that output and `router-history-fixture`.

Observed snapshot id from this run: `fc2801534099ce4e3de23f36141a18f82cad1a335ade1e6ae06f138889cc724d`.

## Failure cases

`pnpm exec vitest run tests/scenarios/local-restore.test.ts` passed the refusal tests. Each one performs the real operation and asserts the error code, the message, and that the target directory is not left behind. The messages observed by those assertions are:

| Case | Error |
| --- | --- |
| Manifest file hash replaced with 64 zeroes | `TAMPERED`: Snapshot was tampered: restored file hashes do not match the manifest |
| Manifest session sha256 replaced | `TAMPERED`: Snapshot was tampered: session export does not match the manifest |
| One byte flipped in a pack under `data/` | `CORRUPTED`: Snapshot is corrupted: restic integrity check failed |
| `formatVersion: 2` | `WRONG_VERSION`: Snapshot format version 2 is not supported (expected 1) |
| `agentVersion: 9.9.9` | `WRONG_VERSION`: Snapshot agent version 9.9.9 does not match pinned OpenCode 2.2.7 |
| `architecture: sparc` | `WRONG_VERSION`: Snapshot architecture sparc does not match host architecture x64 |
| Different runtime digest | `WRONG_VERSION`: Snapshot runtime digest does not match this host |
| `resticVersion: 0.0.0` | `WRONG_VERSION`: Snapshot restic version 0.0.0 does not match pinned restic 0.19.1 |
| Snapshot tree without `session.json` | `INCOMPLETE`: Snapshot is incomplete: missing session export |
| Snapshot id absent from the repository | `INCOMPLETE`: Snapshot is incomplete: requested snapshot is missing |
| Manifest missing `snapshotId` | `INCOMPLETE`: Snapshot manifest is incomplete |
| Symlink inside the workspace | Capture throws before backup |
| Repository directory inside the workspace | Snapshot repository must be independent of the workspace |

A wrong-version manifest is rejected before restore writes a workspace. Tamper and corruption checks delete the target directory when verification fails.

## Limits

- The restore directory is new. OpenCode rebinds `location.directory` to that path. This run does not prove two hosts sharing one absolute workspace path.
- The architecture check compares the manifest with the current process. It does not boot an arm64 worker.
- Pending inbox prompts are still outside the export, as in the readiness round trip. This checkpoint does not add that transfer.
- No model credential was used. The continued command is a fixed shell `printf`, not model recall.
- The restic repository is a local directory created for the test, not off-host object storage. Retention, locks across hosts, and pruning were not exercised.
- `restic check --read-data` covered these small repositories only.
