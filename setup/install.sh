#!/usr/bin/env bash
# Edge installer — runs setup steps 0–8 (see setup/README.md) on:
#   * Linux x86_64 with an NVIDIA GPU   → hardware mode "server"
#   * Linux x86_64 without a GPU        → hardware mode "cpu" (onnxruntime)
#   * NVIDIA Jetson (JetPack 5 / 6)     → hardware mode "jetson"
#   * Windows: run setup/install.ps1, which calls this script inside WSL2
#
# Every step is safe to re-run. Progress is kept in setup/.install-state, so a
# failed run resumes from the failed step the next time you start it.
#
# Usage: ./setup/install.sh [options]
#   -y, --yes            accept defaults, never prompt (passwords are generated)
#   --from STEP          start at STEP (re-runs it and everything after)
#   --only STEP          run just STEP
#   --reset              forget progress and saved answers, start from scratch
#   --model NAME         base weights name (default yolo26s → yolo26s.pt)
#   --imgsz N            model input size (default 640)
#   --external-db        use an existing PostgreSQL instead of the bundled one
#   --external-mqtt      use an existing MQTT broker instead of the bundled one
#   -h, --help
#
# Steps: prereq config infra images dashboard settings models engines triton verify
#
# Non-interactive overrides (env): EDGE_PG_PASSWORD (PostgreSQL superuser, used
# once to create the `edge` database and its roles), EDGE_PG_HOST, EDGE_PG_PORT,
# EDGE_PG_USER, EDGE_MQTT_BROKER, EDGE_MQTT_PORT, EDGE_MQTT_USER,
# EDGE_MQTT_PASSWORD, EDGE_ADMIN_PASSWORD (dashboard admin, default "admin").

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASH="$REPO_ROOT/dashboard"
PC="$REPO_ROOT/python-counting"
SETUP="$REPO_ROOT/setup"
STATE_FILE="$SETUP/.install-state"
ANSWERS_FILE="$SETUP/.install-answers"
LOG_DIR="$SETUP/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

STEPS=(prereq config infra images dashboard settings models engines triton verify)
declare -A STEP_TITLE=(
  [prereq]="Prerequisites (Docker, GPU runtime, disk)"
  [config]="Configuration (.env, database, MQTT)"
  [infra]="Database + MQTT"
  [images]="Camera image + Triton image"
  [dashboard]="Dashboard, stream gateway, nginx, Node-RED"
  [settings]="Dashboard settings (hardware mode, DB, MQTT)"
  [models]="Detection model (ONNX, uint8)"
  [engines]="TensorRT engines"
  [triton]="Triton Inference Server"
  [verify]="End-to-end check"
)
declare -A STEP_DOC=(
  [prereq]="setup/00-pre-setup.md"
  [config]="setup/06-dashboard.md"
  [infra]="setup/01-database.md, setup/02-mqtt.md"
  [images]="setup/03-images.md"
  [dashboard]="setup/06-dashboard.md"
  [settings]="setup/06-dashboard.md"
  [models]="setup/04-models.md"
  [engines]="setup/04-models.md"
  [triton]="setup/05-triton.md"
  [verify]="setup/08-verification.md"
)

ASSUME_YES=false
FROM_STEP=""
ONLY_STEP=""
MODEL_BASE="yolo26s"
IMGSZ=640
FORCE_EXTERNAL_DB=false
FORCE_EXTERNAL_MQTT=false
CURRENT_STEP=""
NET_CONNECT=""

# ---------------------------------------------------------------- output ----
if [ -t 1 ]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'; C_DIM=$'\e[2m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_DIM=""; C_B=""; C_0=""
fi
info()  { echo "${C_BLU}•${C_0} $*"; }
ok()    { echo "${C_GRN}✔${C_0} $*"; }
warn()  { echo "${C_YLW}!${C_0} $*"; WARNINGS+=("$*"); }
WARNINGS=()

# die "what went wrong" "how to fix it" — explicit, expected failures.
die() {
  echo
  echo "${C_RED}${C_B}✖ ${1}${C_0}"
  [ -n "${2:-}" ] && echo "  ${C_B}Fix:${C_0} $2"
  footer_on_failure
  exit 1
}

footer_on_failure() {
  if [ -n "$CURRENT_STEP" ]; then
    echo "  ${C_B}Step:${C_0} $CURRENT_STEP — ${STEP_TITLE[$CURRENT_STEP]}"
    echo "  ${C_B}Docs:${C_0} ${STEP_DOC[$CURRENT_STEP]} (section \"Kalau error\")"
  fi
  echo "  ${C_B}Log:${C_0}  $LOG"
  echo "  After fixing, run ${C_B}./setup/install.sh${C_0} again — it resumes from this step."
}

# Anything not handled by die() lands here: an unexpected command failure.
on_error() {
  local code=$? line=$1 cmd=$2
  # The trap is inherited by subshells (e.g. compose_dash's `( cd … )`); only
  # report once, from the main shell, or the failure is printed twice.
  if [ "$BASHPID" != "$$" ]; then exit "$code"; fi
  trap - ERR
  echo
  echo "${C_RED}${C_B}✖ Unexpected failure (exit $code) at install.sh:$line${C_0}"
  echo "  ${C_B}Command:${C_0} $cmd"
  echo "  ${C_B}Last log lines:${C_0}"
  tail -n 15 "$LOG" | sed 's/^/    /'
  footer_on_failure
  exit "$code"
}
trap 'on_error $LINENO "$BASH_COMMAND"' ERR
trap 'echo; echo "${C_YLW}Interrupted.${C_0} Run ./setup/install.sh again to resume."; exit 130' INT

usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# ----------------------------------------------------------------- input ----
INTERACTIVE=true
[ -t 0 ] || INTERACTIVE=false

# ask VAR "question" default [secret]
ask() {
  local var=$1 q=$2 def=${3:-} secret=${4:-} reply=""
  if [ -n "${!var:-}" ]; then return; fi
  if $ASSUME_YES || ! $INTERACTIVE; then
    printf -v "$var" '%s' "$def"; return
  fi
  if [ "$secret" = secret ]; then
    read -r -s -p "  $q${def:+ [enter = ${def:0:3}…]}: " reply; echo
  else
    read -r -p "  $q${def:+ [$def]}: " reply
  fi
  printf -v "$var" '%s' "${reply:-$def}"
}

confirm() {  # confirm "question" → 0 yes / 1 no (default yes; non-interactive = no unless --yes)
  if $ASSUME_YES; then return 0; fi
  if ! $INTERACTIVE; then return 1; fi
  local reply; read -r -p "  $1 [Y/n]: " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

random_secret() { python3 -c 'import secrets; print(secrets.token_hex(12))'; }

save_answer() {  # persisted so a resumed run doesn't re-ask
  local k=$1 v=$2
  touch "$ANSWERS_FILE"
  ( umask 077
    grep -v "^$k=" "$ANSWERS_FILE" > "$ANSWERS_FILE.tmp" || true
    printf '%s=%q\n' "$k" "$v" >> "$ANSWERS_FILE.tmp" )
  mv "$ANSWERS_FILE.tmp" "$ANSWERS_FILE"
  chmod 600 "$ANSWERS_FILE"
}

set_env_var() {  # set_env_var FILE KEY VALUE — replace or append KEY=VALUE
  local f=$1 k=$2 v=$3
  touch "$f"
  if grep -q "^$k=" "$f"; then
    python3 - "$f" "$k" "$v" <<'PY'
import sys
f, k, v = sys.argv[1:]
lines = open(f).read().splitlines()
open(f, 'w').write('\n'.join(f'{k}={v}' if l.startswith(f'{k}=') else l for l in lines) + '\n')
PY
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

get_env_var() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true; }

# ------------------------------------------------------------------ sudo ----
# Ask for the sudo password once up front (Docker, NVIDIA toolkit, apt, docker
# group all need it), then keep the timestamp fresh so a long build doesn't
# stop halfway for a password prompt.
SUDO_KEEPALIVE_PID=""
acquire_sudo() {
  [ "$(id -u)" = 0 ] && return
  command -v sudo >/dev/null || die "sudo is not installed" "Run this script as root, or install sudo."
  if ! sudo -n true 2>/dev/null; then
    if ! $INTERACTIVE; then
      warn "No cached sudo credentials and no terminal — steps that need sudo will fail. Run 'sudo -v' first or use passwordless sudo."
      return
    fi
    echo "${C_B}Administrator rights are needed (Docker, NVIDIA runtime, packages).${C_0} Enter your password once:"
    sudo -v || die "sudo authentication failed" "Use an account that can run sudo, or run this script as root."
  fi
  ( while kill -0 $$ 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done ) &
  SUDO_KEEPALIVE_PID=$!
}
trap '[ -n "$SUDO_KEEPALIVE_PID" ] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null; true' EXIT

# ---------------------------------------------------------------- docker ----
DOCKER=(docker)
dk() { "${DOCKER[@]}" "$@"; }
resolve_docker() {
  command -v docker >/dev/null || return 1
  if docker info >/dev/null 2>&1; then DOCKER=(docker); return 0; fi
  if sudo -n true 2>/dev/null || $INTERACTIVE; then
    if sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker); return 0; fi
  fi
  return 1
}
compose_dash() { (cd "$DASH" && dk compose "$@"); }
compose_pc()   { (cd "$PC" && dk compose "$@"); }

container_project() { dk inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$1" 2>/dev/null || true; }

# Defaults for reaching an existing DB/MQTT container from our containers.
# Preferred: put it on the shared `envisions` network and use its name + internal
# port (works even when it only publishes on 127.0.0.1). Fallback: the host
# gateway + its published port.
existing_container_target() {  # existing_container_target NAME INTERNAL_PORT → EXIST_HOST EXIST_PORT
  local name=$1 port=$2 published
  if dk inspect -f '{{json .NetworkSettings.Networks}}' "$name" | grep -q '"envisions"'; then
    EXIST_HOST=$name; EXIST_PORT=$port; return
  fi
  if confirm "Connect existing container '$name' to the 'envisions' network so Edge can reach it by name?"; then
    NET_CONNECT="${NET_CONNECT:+$NET_CONNECT }$name"
    EXIST_HOST=$name; EXIST_PORT=$port; return
  fi
  published=$(dk port "$name" "$port/tcp" 2>/dev/null | head -1)
  EXIST_HOST=host.docker.internal; EXIST_PORT=${published##*:}
  if [[ "$published" == 127.0.0.1:* ]]; then
    warn "'$name' only listens on 127.0.0.1 — containers can't reach it via host.docker.internal. Connect it to the envisions network instead."
  fi
}

# A single-arch image for the wrong CPU (e.g. an amd64-only image on Jetson)
# starts and then restart-loops with "exec format error" — catch it by name.
check_container_arch() {  # check_container_arch CONTAINER...
  local host_arch c img arch
  host_arch=$(dk version --format '{{.Server.Arch}}')
  for c in "$@"; do
    img=$(dk inspect -f '{{.Config.Image}}' "$c" 2>/dev/null) || continue
    arch=$(dk image inspect -f '{{.Architecture}}' "$img" 2>/dev/null || true)
    if [ -n "$arch" ] && [ "$arch" != "$host_arch" ]; then
      die "$c uses image $img built for $arch, but this machine is $host_arch" \
        "Use a multi-arch image (pull the right variant with: docker compose pull), or pick an image that publishes $host_arch."
    fi
  done
}

wait_for() {  # wait_for SECONDS "what" command...
  local timeout=$1 what=$2; shift 2
  local start=$SECONDS
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS - start > timeout )); then return 1; fi
    sleep 3
  done
  ok "$what ($((SECONDS - start))s)"
}

# -------------------------------------------------------------- platform ----
detect_platform() {
  ARCH=$(uname -m)
  [ "$(uname -s)" = Linux ] || die "Unsupported OS: $(uname -s)" \
    "Use Linux (x86_64 or Jetson). On Windows run setup/install.ps1 (it uses WSL2)."
  IS_WSL=false
  grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=true
  GPU_WITHOUT_DRIVER=false
  JETPACK=""

  if [ -f /etc/nv_tegra_release ] || grep -qi jetson /proc/device-tree/model 2>/dev/null; then
    PLATFORM="Jetson"
    HARDWARE_MODE=jetson
    local l4t
    l4t=$(sed -n 's/^# R\([0-9]*\).*/\1/p' /etc/nv_tegra_release 2>/dev/null || true)
    case "$l4t" in
      36) JETPACK=6; TRITON_TAG=24.08; EXPORT_BASE=ultralytics/ultralytics:latest-jetson-jetpack6 ;;
      35) JETPACK=5; TRITON_TAG=23.12; EXPORT_BASE=ultralytics/ultralytics:latest-jetson-jetpack5 ;;
      *)  die "Unsupported Jetson L4T release '${l4t:-unknown}'" "JetPack 5.x (L4T R35) or 6.x (L4T R36) is required." ;;
    esac
  elif [ "$ARCH" = x86_64 ]; then
    TRITON_TAG=24.08
    EXPORT_BASE=ultralytics/ultralytics:latest
    if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
      HARDWARE_MODE=server
    elif grep -qs 0x10de /sys/bus/pci/devices/*/vendor; then   # NVIDIA PCI vendor id
      HARDWARE_MODE=server; GPU_WITHOUT_DRIVER=true
    else
      HARDWARE_MODE=cpu
    fi
    if $IS_WSL; then PLATFORM="Windows (WSL2)"; else PLATFORM="Linux x86_64"; fi
  else
    die "Unsupported architecture: $ARCH" "Supported: x86_64 Linux, NVIDIA Jetson."
  fi

  if [ "$HARDWARE_MODE" = jetson ]; then TRITON_IMAGE="nvcr.io/nvidia/tritonserver:${TRITON_TAG}-py3-igpu"
  else TRITON_IMAGE="nvcr.io/nvidia/tritonserver:${TRITON_TAG}-py3"; fi
  MODEL_NAME="${MODEL_BASE}_${IMGSZ}_e2e_u8"
}

print_platform() {
  echo "${C_B}Edge installer${C_0}  ${C_DIM}(log: $LOG)${C_0}"
  echo "  Platform:      $PLATFORM${JETPACK:+ (JetPack $JETPACK)}"
  echo "  Hardware mode: $HARDWARE_MODE"
  echo "  Triton image:  $TRITON_IMAGE"
  echo "  Model:         $MODEL_NAME"
  echo "  Repo:          $REPO_ROOT"
  if [ "$HARDWARE_MODE" = cpu ]; then
    echo "  ${C_YLW}No NVIDIA GPU found — inference will run on CPU (expect only a few cameras).${C_0}"
  fi
  echo
}

# ================================================================= steps ====

step_prereq() {
  local missing=()
  for t in curl git python3; do command -v "$t" >/dev/null || missing+=("$t"); done
  if ((${#missing[@]})); then
    command -v apt-get >/dev/null || die "Missing tools: ${missing[*]}" "Install them with your package manager."
    confirm "Install ${missing[*]} with apt?" || die "Missing tools: ${missing[*]}" "sudo apt-get install -y ${missing[*]}"
    sudo apt-get update -qq && sudo apt-get install -y "${missing[@]}"
  fi
  ok "Base tools: curl, git, python3"

  # Docker
  if ! command -v docker >/dev/null; then
    if $IS_WSL; then
      die "Docker not found inside WSL" \
        "Install Docker Desktop on Windows, then Settings → Resources → WSL integration → enable this distro."
    fi
    [ "$HARDWARE_MODE" = jetson ] && warn "Docker is normally part of JetPack; installing the upstream package."
    confirm "Docker is not installed. Install it now (get.docker.com)?" \
      || die "Docker is required" "curl -fsSL https://get.docker.com | sudo sh"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" || true
    warn "Added $USER to the docker group — log out and back in later to use docker without sudo."
  fi
  resolve_docker || die "Cannot talk to the Docker daemon" \
    "Start it (sudo systemctl start docker, or open Docker Desktop) and make sure your user can run 'docker info'."
  if [ "${DOCKER[0]}" = sudo ] && [ "$(id -u)" != 0 ]; then
    if id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
      warn "$USER is in the docker group but this session predates it — log out and back in to use docker without sudo."
    elif confirm "Add $USER to the docker group so docker works without sudo (after re-login)?"; then
      sudo usermod -aG docker "$USER"
      warn "Added $USER to the docker group — log out and back in for it to take effect. This run keeps using sudo."
    else
      warn "Running docker through sudo for this install (user not in the docker group)."
    fi
  fi
  dk compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin not found" \
    "sudo apt-get install -y docker-compose-plugin"
  ok "Docker $(dk version --format '{{.Server.Version}}'), $(dk compose version --short 2>/dev/null || echo compose v2)"

  # GPU runtime
  case "$HARDWARE_MODE" in
    server)
      if $GPU_WITHOUT_DRIVER; then
        command -v ubuntu-drivers >/dev/null || die "NVIDIA GPU found but no working driver" \
          "Install the NVIDIA driver for your distro, reboot, then re-run this script."
        confirm "NVIDIA GPU found but the driver isn't working. Install the recommended driver now?" \
          || die "NVIDIA driver required" "sudo ubuntu-drivers install && sudo reboot"
        sudo ubuntu-drivers install
        echo
        echo "${C_YLW}${C_B}Driver installed. Reboot now (sudo reboot), then run ./setup/install.sh again.${C_0}"
        exit 0
      fi
      ok "NVIDIA driver $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1), GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
      # The only reliable check is an actual GPU container: a daemon.json that
      # names the nvidia runtime proves nothing if the toolkit package or the
      # CDI spec (used by `--gpus` on Docker 28+) is missing.
      info "Testing GPU access from a container..."
      if ! gpu_container_test; then
        $IS_WSL && die "Containers cannot use the GPU" \
          "Update the NVIDIA Windows driver and Docker Desktop, then enable GPU support in Docker Desktop settings."
        confirm "Containers can't use the GPU yet. Install/repair the NVIDIA Container Toolkit now?" \
          || die "Containers cannot use the GPU" "See setup/00-pre-setup.md step 3, or re-run with --yes to let the installer fix it."
        install_nvidia_toolkit
        gpu_container_test || die "Containers still cannot use the GPU" \
          "Check the error above. 'driver version is insufficient' → upgrade the NVIDIA driver; 'CDI' errors → sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml && sudo systemctl restart docker."
      fi
      ok "GPU visible inside containers"
      ;;
    jetson)
      # A Docker installed/upgraded from docker.com (instead of JetPack's) keeps
      # the toolkit package but loses the nvidia runtime registration.
      if ! dk info --format '{{json .Runtimes}}' | grep -q nvidia; then
        if command -v nvidia-ctk >/dev/null; then
          info "NVIDIA Container Toolkit is installed but not registered with Docker $(dk version --format '{{.Server.Version}}')."
          confirm "Register the nvidia runtime with Docker now (nvidia-ctk runtime configure)?" \
            || die "Docker has no 'nvidia' runtime" "sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
        else
          confirm "NVIDIA Container Toolkit is missing. Install it from the JetPack repo (nvidia-container)?" \
            || die "Docker has no 'nvidia' runtime" \
              "sudo apt-get update && sudo apt-get install -y nvidia-container && sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
          sudo apt-get update -qq
          sudo apt-get install -y nvidia-container \
            || die "Could not install nvidia-container" "Check that the JetPack apt repo (repo.download.nvidia.com/jetson) is in /etc/apt/sources.list.d/."
        fi
        sudo nvidia-ctk runtime configure --runtime=docker
        sudo systemctl restart docker
        sleep 3
        resolve_docker || die "Docker did not come back after the restart" "sudo systemctl status docker; sudo journalctl -u docker -n 50"
        dk info --format '{{json .Runtimes}}' | grep -q nvidia || die "Docker still has no 'nvidia' runtime" \
          "Check /etc/docker/daemon.json; if Docker itself is failing on JetPack 6 with iptables/kernel-module errors, install Docker 27.x instead of 28+."
      fi
      ok "NVIDIA container runtime present (JetPack $JETPACK)"
      check_iptables_raw
      check_jetson_libs
      ;;
    cpu)
      info "CPU mode: skipping GPU checks."
      ;;
  esac

  # Disk + memory
  if ! $IS_WSL; then
    local root free_gb src rota
    root=$(dk info --format '{{.DockerRootDir}}')
    free_gb=$(df -BG --output=avail "$root" 2>/dev/null | tail -1 | tr -dc 0-9)
    if [ -n "$free_gb" ] && [ "$free_gb" -lt 40 ]; then
      die "Only ${free_gb} GB free under Docker's data dir ($root)" \
        "Images + models need ~40 GB. Free space or move Docker's data-root to a larger SSD (setup/00-pre-setup.md step 4)."
    fi
    ok "Disk: ${free_gb:-?} GB free under $root"
    for p in "$root" "$REPO_ROOT"; do
      src=$(df --output=source "$p" 2>/dev/null | tail -1)
      rota=$(lsblk -ndo ROTA "$src" 2>/dev/null | tr -d ' ' || true)
      [ "$rota" = 1 ] && warn "$p is on a spinning disk ($src). Move it to SSD/NVMe — HDD journal stalls freeze every camera at once."
    done
  fi
  local mem_gb
  mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
  [ "$mem_gb" -lt 15 ] && warn "Only ${mem_gb} GB RAM — 16 GB or more is recommended."
  ok "Memory: ${mem_gb} GB"
}

# Triton's -igpu image gets Tegra libraries from the host via the NVIDIA runtime
# (CSV mode). On minimal JetPack installs (no nvidia-jetpack metapackage)
# libnvdla_compiler.so is missing, and TensorRT 10 can't load its plugins:
# "Unable to open library: libnvinfer_plugin.so.10 due to libnvdla_compiler.so".
check_jetson_libs() {
  local lib=/usr/lib/aarch64-linux-gnu/nvidia/libnvdla_compiler.so l4t
  [ -e "$lib" ] && { ok "Tegra TensorRT libraries present"; return; }
  l4t=$(dpkg-query -W -f='${Version}' nvidia-l4t-core 2>/dev/null || true)
  [ -n "$l4t" ] || die "$lib is missing and the L4T version is unknown" "Install nvidia-l4t-dla-compiler matching your L4T release."
  info "Missing $lib (package nvidia-l4t-dla-compiler) — TensorRT engine builds would fail."
  confirm "Install nvidia-l4t-dla-compiler=$l4t (same version as your L4T, nothing else is upgraded)?" \
    || die "Missing $lib" "sudo apt-get install -y nvidia-l4t-dla-compiler=$l4t"
  sudo apt-get install -y "nvidia-l4t-dla-compiler=$l4t" \
    || die "Could not install nvidia-l4t-dla-compiler=$l4t" "sudo apt-get update, then retry; check the JetPack apt repo is configured."
  ok "Installed nvidia-l4t-dla-compiler $l4t"
}

# Docker 28+ adds "direct access filtering" rules to the iptables raw table.
# Stock JetPack 6 kernels don't ship that table, so every container on a custom
# network fails with "can't initialize iptables table `raw'".
check_iptables_raw() {
  local major
  major=$(dk version --format '{{.Server.Version}}' | cut -d. -f1)
  [ "${major:-0}" -ge 28 ] || return 0
  if sudo iptables -t raw -L -n >/dev/null 2>&1; then ok "iptables raw table available"; return; fi
  if sudo modprobe iptable_raw 2>/dev/null && sudo iptables -t raw -L -n >/dev/null 2>&1; then
    echo iptable_raw | sudo tee /etc/modules-load.d/iptable_raw.conf >/dev/null
    ok "Loaded the iptable_raw kernel module (persisted in /etc/modules-load.d)"
    return
  fi
  if grep -qs DOCKER_INSECURE_NO_IPTABLES_RAW /etc/systemd/system/docker.service.d/*.conf; then
    ok "Docker configured to run without the iptables raw table"; return
  fi
  info "Docker $(dk version --format '{{.Server.Version}}') needs the iptables 'raw' table, which this kernel doesn't have."
  confirm "Configure Docker to skip the raw-table rules (DOCKER_INSECURE_NO_IPTABLES_RAW=1, same behaviour as Docker 27)?" \
    || die "This kernel has no iptables raw table, which Docker ${major}+ requires" \
      "Either set DOCKER_INSECURE_NO_IPTABLES_RAW=1 for docker.service, or install Docker 27.x (see setup/00-pre-setup.md)."
  sudo mkdir -p /etc/systemd/system/docker.service.d
  printf '[Service]\nEnvironment="DOCKER_INSECURE_NO_IPTABLES_RAW=1"\n' \
    | sudo tee /etc/systemd/system/docker.service.d/10-no-iptables-raw.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart docker
  sleep 3
  resolve_docker || die "Docker did not come back after the restart" "sudo journalctl -u docker -n 50"
  ok "Docker configured to run without the iptables raw table"
}

gpu_container_test() {
  dk run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi -L
}

install_nvidia_toolkit() {
  if ! command -v nvidia-ctk >/dev/null; then
    command -v apt-get >/dev/null || die "Automatic toolkit install needs apt" "Follow setup/00-pre-setup.md step 3 manually."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y nvidia-container-toolkit
  fi
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo mkdir -p /etc/cdi
  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml   # Docker 28+ resolves --gpus through CDI
  sudo systemctl restart docker
  sleep 3
  ok "NVIDIA Container Toolkit installed"
}

step_config() {
  [ -f "$DASH/.env" ] || cp "$DASH/.env.example" "$DASH/.env"
  set_env_var "$DASH/.env" HOST_PYTHON_COUNTING_DIR "$PC"
  ok "dashboard/.env: HOST_PYTHON_COUNTING_DIR=$PC"

  # --- PostgreSQL ---------------------------------------------------------
  if [ -z "${USE_BUNDLED_DB:-}" ]; then
    USE_BUNDLED_DB=true
    if $FORCE_EXTERNAL_DB; then USE_BUNDLED_DB=false
    elif dk inspect env_services_timescaledb >/dev/null 2>&1 && [ "$(container_project env_services_timescaledb)" != dashboard ]; then
      info "Found an existing PostgreSQL container 'env_services_timescaledb' from another stack — using it."
      USE_BUNDLED_DB=false
      existing_container_target env_services_timescaledb 5432
      PG_HOST=${PG_HOST:-$EXIST_HOST}; PG_PORT=${PG_PORT:-$EXIST_PORT}
    fi
  fi
  if $USE_BUNDLED_DB; then
    local existing; existing=$(get_env_var "$DASH/.env" POSTGRES_PASSWORD)
    PG_PASS=${EDGE_PG_PASSWORD:-${PG_PASS:-}}
    if [ -z "$PG_PASS" ] && [ -n "$existing" ] && [ "$existing" != change-me ]; then PG_PASS=$existing; fi
    ask PG_PASS "Password for the bundled PostgreSQL (enter = generate)" "$(random_secret)" secret
    if dk volume inspect dashboard_timescaledb_volume >/dev/null 2>&1 && [ "$PG_PASS" != "$existing" ]; then
      warn "Volume dashboard_timescaledb_volume already exists — PostgreSQL keeps the password it was created with."
    fi
    set_env_var "$DASH/.env" POSTGRES_PASSWORD "$PG_PASS"
    PG_HOST=env_services_timescaledb; PG_PORT=5432; PG_DB=postgres; PG_USER=postgres
    ok "PostgreSQL: bundled (env_services_timescaledb, host port 5435)"
  else
    PG_HOST=${EDGE_PG_HOST:-${PG_HOST:-}}; PG_PORT=${EDGE_PG_PORT:-${PG_PORT:-}}
    [ -n "$PG_HOST" ] && info "Using $PG_HOST:$PG_PORT (override with EDGE_PG_HOST / EDGE_PG_PORT)"
    PG_DB=${EDGE_PG_DB:-${PG_DB:-}}; PG_USER=${EDGE_PG_USER:-${PG_USER:-}}
    PG_PASS=${EDGE_PG_PASSWORD:-${PG_PASS:-}}
    echo "  Existing PostgreSQL (reached from containers). The superuser is used once,"
    echo "  to create the database 'edge' and the roles edge_owner / edge_device:"
    ask PG_HOST "Host" "host.docker.internal"
    ask PG_PORT "Port" "5435"
    PG_DB=postgres
    ask PG_USER "Superuser" "postgres"
    ask PG_PASS "Superuser password" "" secret
    [ -n "$PG_PASS" ] || die "No PostgreSQL superuser password given" "Re-run interactively, or set EDGE_PG_PASSWORD."
    ok "PostgreSQL: existing ($PG_HOST:$PG_PORT)"
  fi

  # Application roles for database `edge` — generated once, kept in dashboard/.env.
  EDGE_OWNER_PASS=${EDGE_OWNER_PASS:-$(get_env_var "$DASH/.env" EDGE_DB_PASSWORD)}
  EDGE_DEVICE_PASS=${EDGE_DEVICE_PASS:-$(get_env_var "$DASH/.env" EDGE_DEVICE_DB_PASSWORD)}
  [ -n "$EDGE_OWNER_PASS" ] || EDGE_OWNER_PASS=$(random_secret)
  [ -n "$EDGE_DEVICE_PASS" ] || EDGE_DEVICE_PASS=$(random_secret)
  set_env_var "$DASH/.env" EDGE_DB_HOST "$PG_HOST"
  set_env_var "$DASH/.env" EDGE_DB_PORT "$PG_PORT"
  set_env_var "$DASH/.env" EDGE_DB_NAME edge
  set_env_var "$DASH/.env" EDGE_DB_USER edge_owner
  set_env_var "$DASH/.env" EDGE_DB_PASSWORD "$EDGE_OWNER_PASS"
  set_env_var "$DASH/.env" EDGE_DEVICE_DB_USER edge_device
  set_env_var "$DASH/.env" EDGE_DEVICE_DB_PASSWORD "$EDGE_DEVICE_PASS"
  ok "dashboard/.env: database edge on $PG_HOST:$PG_PORT (roles edge_owner, edge_device)"

  # --- MQTT ---------------------------------------------------------------
  if [ -z "${USE_BUNDLED_MQTT:-}" ]; then
    USE_BUNDLED_MQTT=true
    if $FORCE_EXTERNAL_MQTT; then USE_BUNDLED_MQTT=false
    elif dk inspect env_services_mqtt >/dev/null 2>&1 && [ "$(container_project env_services_mqtt)" != dashboard ]; then
      info "Found an existing MQTT container 'env_services_mqtt' from another stack — using it."
      USE_BUNDLED_MQTT=false
      existing_container_target env_services_mqtt 1883
      MQTT_BROKER=${MQTT_BROKER:-$EXIST_HOST}; MQTT_PORT=${MQTT_PORT:-$EXIST_PORT}
    fi
  fi
  if $USE_BUNDLED_MQTT; then
    MQTT_BROKER=env_services_mqtt; MQTT_PORT=1883; MQTT_USER=""; MQTT_PASS=""
    ok "MQTT: bundled (env_services_mqtt, host port 1884)"
  else
    MQTT_BROKER=${EDGE_MQTT_BROKER:-${MQTT_BROKER:-}}; MQTT_PORT=${EDGE_MQTT_PORT:-${MQTT_PORT:-}}
    [ -n "$MQTT_BROKER" ] && info "Using $MQTT_BROKER:$MQTT_PORT (override with EDGE_MQTT_BROKER / EDGE_MQTT_PORT)"
    MQTT_USER=${EDGE_MQTT_USER:-${MQTT_USER:-}}; MQTT_PASS=${EDGE_MQTT_PASSWORD:-${MQTT_PASS:-}}
    echo "  Existing MQTT broker (reached from containers):"
    ask MQTT_BROKER "Broker host/IP" ""
    [ -n "$MQTT_BROKER" ] || die "No MQTT broker given" "Re-run interactively, set EDGE_MQTT_BROKER, or drop --external-mqtt."
    ask MQTT_PORT "Port" "1883"
    ask MQTT_USER "Username (enter = none)" ""
    [ -n "$MQTT_USER" ] && ask MQTT_PASS "Password" "" secret
    ok "MQTT: existing ($MQTT_BROKER:$MQTT_PORT)"
  fi

  for k in NET_CONNECT USE_BUNDLED_DB PG_HOST PG_PORT PG_DB PG_USER PG_PASS EDGE_OWNER_PASS EDGE_DEVICE_PASS USE_BUNDLED_MQTT MQTT_BROKER MQTT_PORT MQTT_USER MQTT_PASS; do
    save_answer "$k" "${!k}"
  done

  # --- Ports --------------------------------------------------------------
  local ports=(3001 8555 8000 8001 8002)
  $USE_BUNDLED_DB && ports+=(5435)
  $USE_BUNDLED_MQTT && ports+=(1884 9001)
  local conflicts=() owner
  local ours_re='^(edge-dashboard|stream-gateway|edge-portfwd-nginx|nodered|triton-inference-server|env_services_timescaledb|env_services_mqtt)$'
  command -v ss >/dev/null || { warn "'ss' not found — skipping the port check."; ports=(); }
  for p in "${ports[@]}"; do
    ss -Htln "sport = :$p" 2>/dev/null | grep -q . || continue
    # `publish=` also matches ports inside a collapsed range (e.g. 8000-8002->8000-8002).
    owner=$(dk ps --filter "publish=$p" --format '{{.Names}}' | head -1)
    [[ -n "$owner" && "$owner" =~ $ours_re ]] || conflicts+=("$p${owner:+ ($owner)}")
  done
  ((${#conflicts[@]} == 0)) || die "Port(s) already in use by something else: ${conflicts[*]}" \
    "Stop that service (sudo ss -ltnp shows who listens), or change the host port in the compose file."
  ((${#ports[@]})) && ok "Ports free: ${ports[*]}"
}

step_infra() {
  # Re-checked here (not only in prereq) so a resumed run on a box whose Docker
  # was upgraded in between still catches it before creating networks.
  $IS_WSL || check_iptables_raw
  # Create the shared network the compose way (labelled), so both compose
  # projects can use it, then attach any existing DB/MQTT container chosen in config.
  if ! dk network inspect envisions >/dev/null 2>&1; then
    compose_dash up --no-start edge-portfwd-nginx
  fi
  local c
  for c in ${NET_CONNECT:-}; do
    if ! dk inspect -f '{{json .NetworkSettings.Networks}}' "$c" | grep -q '"envisions"'; then
      dk network connect envisions "$c"
      ok "Connected $c to the envisions network"
    fi
  done

  local svcs=()
  $USE_BUNDLED_DB && svcs+=(timescaledb)
  $USE_BUNDLED_MQTT && svcs+=(mqtt)
  if ((${#svcs[@]})); then
    info "Starting ${svcs[*]}..."
    compose_dash pull "${svcs[@]}"
    compose_dash up -d "${svcs[@]}"
    $USE_BUNDLED_DB && check_container_arch env_services_timescaledb
    $USE_BUNDLED_MQTT && check_container_arch env_services_mqtt
  fi

  if $USE_BUNDLED_DB; then
    wait_for 120 "PostgreSQL is accepting connections" dk exec env_services_timescaledb pg_isready -U postgres \
      || die "PostgreSQL did not become ready" "Check: docker logs env_services_timescaledb"
  fi

  create_edge_database
  ok "Database edge ready (tables are created by the dashboard on start)"

  info "Testing MQTT..."
  local auth=()
  [ -n "${MQTT_USER:-}" ] && auth=(-u "$MQTT_USER" -P "$MQTT_PASS")
  wait_for 60 "MQTT broker accepts publishes" dk run --rm --network envisions --add-host host.docker.internal:host-gateway \
    eclipse-mosquitto:2.0 mosquitto_pub -h "$MQTT_BROKER" -p "$MQTT_PORT" "${auth[@]}" -t edge/install -m ok \
    || die "Cannot publish to MQTT at $MQTT_BROKER:$MQTT_PORT" \
      "Bundled: docker logs env_services_mqtt. Existing broker: check address, credentials and firewall."
}

# Roles + database `edge`, idempotent. Passwords go in as psql variables and are
# re-applied on every run so dashboard/.env and the server never drift apart.
EDGE_DB_SQL=$(cat <<'SQL'
SELECT format('CREATE ROLE edge_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_owner') \gexec
SELECT format('CREATE ROLE edge_device LOGIN PASSWORD %L', :'device_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_device') \gexec
SELECT format('ALTER ROLE edge_owner LOGIN PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE edge_device LOGIN PASSWORD %L', :'device_pw') \gexec
SELECT 'CREATE DATABASE edge OWNER edge_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'edge') \gexec
REVOKE CONNECT ON DATABASE edge FROM PUBLIC;
GRANT CONNECT ON DATABASE edge TO edge_owner, edge_device;
\c edge
ALTER SCHEMA public OWNER TO edge_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
)

run_psql_super() {  # stdin = SQL
  if $USE_BUNDLED_DB; then
    dk exec -i env_services_timescaledb psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
  else
    dk run --rm -i --network envisions --add-host host.docker.internal:host-gateway -e PGPASSWORD="$PG_PASS" \
      postgres:16-alpine psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"
  fi
}

create_edge_database() {
  info "Creating database 'edge' and roles edge_owner / edge_device..."
  printf '%s\n' "$EDGE_DB_SQL" | run_psql_super -v owner_pw="$EDGE_OWNER_PASS" -v device_pw="$EDGE_DEVICE_PASS" \
    || die "Could not create the database 'edge' and its roles" \
      "Check the superuser password and that the server is reachable from containers (setup/01-database.md)."
  if $USE_BUNDLED_DB; then
    # Our own server: application roles shouldn't reach the default database either.
    echo 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;' | run_psql_super || true
  fi
  # The camera role must be able to log in to `edge` (and nothing else).
  dk run --rm --network envisions --add-host host.docker.internal:host-gateway -e PGPASSWORD="$EDGE_DEVICE_PASS" \
    postgres:16-alpine psql -h "$PG_HOST" -p "$PG_PORT" -U edge_device -d edge -tAc 'SELECT 1' >/dev/null \
    || die "Role edge_device cannot log in to database edge" "See the error above; pg_hba.conf may reject password logins from Docker networks."
}

step_images() {
  info "Building the camera image (edge-device:latest)..."
  dk build -t edge-device:latest "$PC"
  dk run --rm edge-device:latest \
    python -c "import cv2, tritonclient.grpc, psycopg2, paho.mqtt, lap" \
    || die "Camera image built but its Python dependencies don't import" \
      "On Jetson/arm64 a wheel may be missing for this architecture — see the import error above."
  ok "Camera image ready"
  info "Pulling $TRITON_IMAGE (large, first time only)..."
  dk pull "$TRITON_IMAGE"
  ok "Triton image ready"
}

step_dashboard() {
  local svcs=(dashboard stream-gateway edge-portfwd-nginx nodered)
  $USE_BUNDLED_DB && svcs+=(timescaledb)
  $USE_BUNDLED_MQTT && svcs+=(mqtt)
  info "Building and starting ${svcs[*]} (first build takes a few minutes)..."
  compose_dash up -d --build "${svcs[@]}"
  check_container_arch edge-dashboard stream-gateway edge-portfwd-nginx nodered
  wait_for 300 "Dashboard is up and the database schema is migrated" curl -fsS http://localhost:3001/api/health \
    || { compose_dash logs --tail 40 dashboard || true
         die "Dashboard did not come up" "See the dashboard log above (docker compose logs dashboard in dashboard/)."; }
}

step_settings() {
  info "Signing in to the dashboard as admin..."
  local jar="$SETUP/.install-cookies"
  ( umask 077; : > "$jar" )
  EDGE_ADMIN_PASSWORD=${EDGE_ADMIN_PASSWORD:-admin}
  local login
  login=$(ADMIN_PW="$EDGE_ADMIN_PASSWORD" python3 -c 'import json,os; print(json.dumps({"username":"admin","password":os.environ["ADMIN_PW"]}))')
  if ! curl -fsS -c "$jar" -H 'Content-Type: application/json' --data "$login" http://localhost:3001/api/auth/login >/dev/null; then
    rm -f "$jar"
    die "Could not sign in to the dashboard as admin" "If the admin password was changed, run again with EDGE_ADMIN_PASSWORD=<password>."
  fi

  info "Applying settings through the dashboard API..."
  local body resp
  body=$(HW="$HARDWARE_MODE" TAG="$TRITON_TAG" MODEL="$MODEL_NAME" \
         MQB="$MQTT_BROKER" MQP="$MQTT_PORT" MQU="${MQTT_USER:-}" MQW="${MQTT_PASS:-}" python3 - <<'PY'
import json, os
e = os.environ
print(json.dumps({
    "applyHardwareMode": True,
    "hardwareMode": e["HW"],
    "triton": {"imageTag": e["TAG"], "defaultModel": e["MODEL"]},
    "mqtt": {"broker": e["MQB"], "port": e["MQP"], "username": e["MQU"], "password": e["MQW"]},
}))
PY
)
  resp=$(curl -fsS -b "$jar" -X PUT -H 'Content-Type: application/json' --data "$body" http://localhost:3001/api/settings) \
    || { rm -f "$jar"; die "Dashboard rejected the settings" "Check: docker compose logs dashboard (in dashboard/)."; }
  rm -f "$jar"
  grep -q '"success":true' <<<"$resp" || die "Unexpected settings response: $resp" "Check the dashboard log."
  grep -qx "TRITON_IMAGE=$TRITON_IMAGE" "$PC/.env" 2>/dev/null || die "python-counting/.env was not written for mode '$HARDWARE_MODE'" \
    "Check that the dashboard can write python-counting/ (bind mount ../python-counting) — docker compose logs dashboard."
  ok "Hardware mode $HARDWARE_MODE, Triton $TRITON_IMAGE, default model $MODEL_NAME"
  ok "MQTT $MQTT_BROKER:$MQTT_PORT (applies to every camera)"
}

step_models() {
  local dst="$PC/models/$MODEL_NAME"
  if [ -f "$dst/1/model.onnx" ]; then ok "Model $MODEL_NAME already present"; return; fi

  info "Building the export image (base $EXPORT_BASE)..."
  dk build --build-arg BASE="$EXPORT_BASE" -f "$PC/tools/Dockerfile.export" -t yolo-export "$PC/tools"

  local weights="/work/python-counting/${MODEL_BASE}.pt"
  if [ ! -f "$PC/${MODEL_BASE}.pt" ]; then
    info "No python-counting/${MODEL_BASE}.pt — letting Ultralytics download the official weights."
    weights="${MODEL_BASE}.pt"
  fi
  mkdir -p "$REPO_ROOT/model-sources"
  info "Exporting ${MODEL_BASE} at ${IMGSZ}px to ONNX (a few minutes)..."
  dk run --rm -v "$REPO_ROOT:/work" yolo-export \
    --weights "$weights" --imgsz "$IMGSZ" --name "${MODEL_BASE}_${IMGSZ}_e2e" --out-dir /work/model-sources \
    || die "ONNX export failed" \
      "If the download failed, put ${MODEL_BASE}.pt in python-counting/ and re-run. See the export output above."
  info "Adding the uint8 input..."
  dk run --rm -v "$REPO_ROOT:/work" --entrypoint python yolo-export \
    /work/python-counting/tools/make_uint8_input.py \
    --src "/work/model-sources/${MODEL_BASE}_${IMGSZ}_e2e" --dst "/work/python-counting/models/$MODEL_NAME"
  dk run --rm -v "$REPO_ROOT:/work" alpine chown -R "$(id -u):$(id -g)" /work/model-sources "/work/python-counting/models/$MODEL_NAME"
  ok "Model $MODEL_NAME exported"
}

step_engines() {
  if [ "$HARDWARE_MODE" = cpu ]; then info "CPU mode: no TensorRT engines, Triton uses onnxruntime."; return; fi
  [ "$HARDWARE_MODE" = jetson ] && check_jetson_libs
  info "Building TensorRT engines on this GPU (several minutes per model)..."
  compose_pc --profile build run --rm triton-model-builder
  local failed=()
  for d in "$PC"/models/*/; do
    [ -f "$d/metadata.json" ] || continue
    [ -f "$d/1/model.plan" ] || failed+=("$(basename "$d")")
  done
  if [[ " ${failed[*]} " == *" $MODEL_NAME "* ]]; then
    die "TensorRT build failed for $MODEL_NAME" "Scroll up for trtexec errors. Common causes: out of GPU memory (stop Triton first), wrong Triton image for this device."
  fi
  ((${#failed[@]})) && warn "No engine for: ${failed[*]} — they run on onnxruntime (slower)."
  ok "Engines ready"
}

step_triton() {
  info "Starting Triton..."
  compose_pc up -d triton
  # Wait for OUR model, not the server-wide ready flag: an optional model that
  # can't load (e.g. arcface_112 without its ONNX) shouldn't block the install.
  wait_for 300 "Triton is serving $MODEL_NAME" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/v2/models/$MODEL_NAME/ready)\" = 200 ]" \
    || { dk logs --tail 60 triton-inference-server || true
         die "Triton did not become ready" "See the Triton log above. Engine/version errors: re-run with --from engines after FORCE_BUILD."; }
  local notready
  notready=$(curl -fsS -X POST http://localhost:8000/v2/repository/index | python3 -c 'import json, sys
print(" ".join("%s(%s)" % (m["name"], m.get("reason") or m.get("state")) for m in json.load(sys.stdin) if m.get("state") != "READY"))')
  if [ -n "$notready" ]; then
    if [[ "$notready" == *"$MODEL_NAME"* ]]; then
      dk logs --tail 60 triton-inference-server || true
      die "Model $MODEL_NAME is not READY on Triton: $notready" "See the Triton log above (setup/05-triton.md)."
    fi
    warn "Models not READY: $notready"
  fi
  ok "Triton serving $MODEL_NAME"
}

step_verify() {
  info "Batch check with frames from python-counting/1.mp4..."
  dk run --rm -v "$PC:/app" -w /app edge-device:latest python -c "
import cv2, os
os.makedirs('.install-frames', exist_ok=True)
c = cv2.VideoCapture('1.mp4')
for i, pos in enumerate((30, 90, 150)):
    c.set(cv2.CAP_PROP_POS_FRAMES, pos)
    ok, f = c.read()
    assert ok, 'cannot read 1.mp4'
    cv2.imwrite(f'.install-frames/{i}.jpg', f)
"
  local out
  out=$(dk run --rm --network envisions -v "$PC:/app" -w /app edge-device:latest \
        python tools/batch_check.py --model "$MODEL_NAME" .install-frames/0.jpg .install-frames/1.jpg .install-frames/2.jpg)
  echo "$out" | sed 's/^/    /'
  dk run --rm -v "$PC:/app" alpine rm -rf /app/.install-frames
  grep -q DIFFERENT <<<"$out" && die "Batched inference gives different results than single frames" \
    "The model was exported with NMS inside (nms=True). Re-export: ./setup/install.sh --from models after deleting python-counting/models/$MODEL_NAME"
  ok "Batched inference matches single-frame inference"

  echo
  echo "${C_B}Containers${C_0}"
  dk ps --format '  {{.Names}}\t{{.Status}}' | grep -E 'edge-dashboard|stream-gateway|edge-portfwd-nginx|nodered|triton-inference-server|env_services' || true
}

# ================================================================== main ====

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=true ;;
    --from) FROM_STEP=${2:?--from needs a step}; shift ;;
    --only) ONLY_STEP=${2:?--only needs a step}; shift ;;
    --reset) rm -f "$STATE_FILE" "$ANSWERS_FILE" ;;
    --model) MODEL_BASE=${2:?}; shift ;;
    --imgsz) IMGSZ=${2:?}; shift ;;
    --external-db) FORCE_EXTERNAL_DB=true ;;
    --external-mqtt) FORCE_EXTERNAL_MQTT=true ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
  shift
done
for s in "$FROM_STEP" "$ONLY_STEP"; do
  [ -z "$s" ] || [[ " ${STEPS[*]} " == *" $s "* ]] || { echo "Unknown step '$s'. Steps: ${STEPS[*]}"; exit 2; }
done

detect_platform
print_platform
acquire_sudo
# shellcheck disable=SC1090
[ -f "$ANSWERS_FILE" ] && source "$ANSWERS_FILE"
touch "$STATE_FILE"

if $IS_WSL; then
  warn "WSL2 is experimental: containers the dashboard creates bind-mount WSL paths through Docker Desktop. After adding a camera, check its container sees /app (docker exec <container> ls /app)."
fi

started=false
[ -z "$FROM_STEP" ] && [ -z "$ONLY_STEP" ] && started=true
for step in "${STEPS[@]}"; do
  if [ -n "$ONLY_STEP" ]; then [ "$step" = "$ONLY_STEP" ] || continue
  elif [ "$step" = "$FROM_STEP" ]; then started=true; sed -i "/^$step\$/,\$d" "$STATE_FILE"
  elif ! $started; then continue
  fi

  # Steps that need docker / earlier answers even when skipped
  if [ "$step" != prereq ]; then resolve_docker || die "Cannot talk to the Docker daemon" "Start Docker and re-run."; fi

  if [ -z "$ONLY_STEP" ] && grep -qx "$step" "$STATE_FILE" && [ "$step" != config ]; then
    echo "${C_DIM}✔ ${STEP_TITLE[$step]} (done earlier)${C_0}"
    continue
  fi
  # config always re-runs (cheap, and restores answers into variables)
  CURRENT_STEP=$step
  echo
  echo "${C_B}── ${STEP_TITLE[$step]} ──${C_0}"
  "step_$step"
  grep -qx "$step" "$STATE_FILE" || echo "$step" >> "$STATE_FILE"
done
CURRENT_STEP=""

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "${C_GRN}${C_B}✔ Edge is installed.${C_0}"
echo "  Dashboard:  http://${IP:-localhost}:3001   (sign in: admin / admin, viewer: user / user)"
echo "  Next:       Detection → Devices → Add Camera (setup/07-add-camera.md)"
if ((${#WARNINGS[@]})); then
  echo "  ${C_YLW}Warnings:${C_0}"
  printf '    - %s\n' "${WARNINGS[@]}"
fi
echo "  Log:        $LOG"
