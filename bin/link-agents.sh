#!/usr/bin/env bash
# Symlink every units/*/agents/*.md into the Pi agent home agents directory.
# Replaces existing symlinks; refuses to overwrite regular files.
# Prunes stale symlinks that once pointed under this repo's units/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
UNITS_DIR="${REPO_ROOT}/units"
AGENT_HOME="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
AGENTS_DIR="${AGENT_HOME}/agents"

# Collapse "." and ".." lexically. BSD realpath has no -m, so a dangling link
# target cannot be normalized by realpath on macOS.
normalize_path() {
  local path="$1" part out=""
  local -a parts=()
  local IFS='/'
  read -r -a parts <<< "${path}"
  for part in "${parts[@]}"; do
    case "${part}" in
      ""|".") ;;
      "..") out="${out%/*}" ;;
      *) out="${out}/${part}" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

mkdir -p "${AGENTS_DIR}"

linked=0
skipped=0
replaced=0
pruned=0

# Newline-delimited rather than an associative array: `declare -A` needs Bash 4,
# and macOS still ships 3.2 as /bin/bash.
desired_names=$'\n'

shopt -s nullglob
for agent_path in "${REPO_ROOT}"/units/*/agents/*.md; do
  name="$(basename "${agent_path}")"
  dest="${AGENTS_DIR}/${name}"
  target="$(realpath "${agent_path}")"
  desired_names="${desired_names}${name}"$'\n'

  if [[ -L "${dest}" ]]; then
    current="$(readlink "${dest}")"
    if [[ "${current}" == "${target}" ]]; then
      echo "ok (unchanged): ${name} -> ${target}"
      skipped=$((skipped + 1))
      continue
    fi
    rm -f "${dest}"
    ln -s "${target}" "${dest}"
    echo "replaced: ${name} -> ${target}"
    replaced=$((replaced + 1))
    linked=$((linked + 1))
    continue
  fi

  if [[ -e "${dest}" ]]; then
    echo "refuse: ${dest} exists and is not a symlink" >&2
    exit 1
  fi

  ln -s "${target}" "${dest}"
  echo "linked: ${name} -> ${target}"
  linked=$((linked + 1))
done
shopt -u nullglob

if [[ ${linked} -eq 0 && ${skipped} -eq 0 ]]; then
  echo "no agent files found under ${REPO_ROOT}/units/*/agents/" >&2
  exit 1
fi

# Prune stale symlinks owned by this package (target under units/, not in desired set).
shopt -s nullglob
for entry in "${AGENTS_DIR}"/*; do
  [[ -L "${entry}" ]] || continue
  name="$(basename "${entry}")"
  case "${desired_names}" in
    *$'\n'"${name}"$'\n'*) continue ;;
  esac

  # Use stored link text so dangling targets still classify, and normalize
  # lexically so the comparison does not depend on the target existing.
  link_text="$(readlink "${entry}")"
  if [[ "${link_text}" = /* ]]; then
    candidate="$(normalize_path "${link_text}")"
  else
    candidate="$(normalize_path "${AGENTS_DIR}/${link_text}")"
  fi

  case "${candidate}" in
    "${UNITS_DIR}"|"${UNITS_DIR}"/*)
      rm -f "${entry}"
      echo "pruned: ${name}"
      pruned=$((pruned + 1))
      ;;
  esac
done
shopt -u nullglob

echo "done: linked=${linked} replaced=${replaced} unchanged=${skipped} pruned=${pruned} dir=${AGENTS_DIR}"
