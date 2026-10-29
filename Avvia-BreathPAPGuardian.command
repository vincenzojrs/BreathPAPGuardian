#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Double-click from Finder. Keep this file beside server.py.
set -u

bpg_fail() {
  printf '\n%s\n' "$1"
  printf 'Premi Invio per chiudere.\n'
  read -r _bpg_reply
  exit 1
}

BPG_REPO_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$BPG_REPO_DIR" || exit 1
[[ -f server.py ]] || bpg_fail "server.py non trovato: lascia questo launcher nella cartella della repo."
command -v python3 >/dev/null 2>&1 || bpg_fail "Python 3 non trovato. Installa Python e riprova."

BPG_WORK_DIR="${BPG_WORK_DIR:-$HOME/Library/Application Support/BreathPAPGuardian/portable}"

if [[ -z "${BPG_SHARED_DIR:-}" ]]; then
  bpg_match_count=0
  bpg_match_path=''
  for bpg_candidate in "$HOME"/Library/CloudStorage/ProtonDrive-*/PAP Archive; do
    if [[ -d "$bpg_candidate" ]]; then
      bpg_match_count=$((bpg_match_count + 1))
      bpg_match_path="$bpg_candidate"
    fi
  done
  if [[ $bpg_match_count -eq 1 ]]; then
    BPG_SHARED_DIR="$bpg_match_path"
  else
    BPG_SHARED_DIR="$(osascript -e 'POSIX path of (choose folder with prompt "Seleziona la cartella PAP Archive in Proton Drive")')" || exit 0
    BPG_SHARED_DIR="${BPG_SHARED_DIR%/}"
  fi
fi

[[ -d "$BPG_SHARED_DIR" ]] || bpg_fail "Cartella Proton Drive non disponibile: $BPG_SHARED_DIR"

printf 'BreathPAPGuardian · archivio reale\n'
printf 'Cartella di lavoro: %s\nCartella Proton Drive: %s\n' "$BPG_WORK_DIR" "$BPG_SHARED_DIR"
printf '\nAttendi la sincronizzazione di Proton Drive.\n'
printf 'Apri http://127.0.0.1:8765 quando il server indica che è pronto.\n'
printf 'Lascia aperta questa finestra. Dopo Salva e chiudi, premi Ctrl+C per fermare il server.\n\n'

python3 server.py --data-dir "$BPG_WORK_DIR" --shared-dir "$BPG_SHARED_DIR"
bpg_result=$?
if [[ $bpg_result -ne 0 ]]; then
  printf '\nAvvio interrotto (codice %s). Controlla il messaggio sopra.\n' "$bpg_result"
  printf 'Se la porta è occupata, ferma il precedente server con Ctrl+C.\nPremi Invio per chiudere.\n'
  read -r _bpg_reply
fi
exit "$bpg_result"
