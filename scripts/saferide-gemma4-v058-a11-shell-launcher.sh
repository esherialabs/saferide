#!/usr/bin/env bash
set -euo pipefail

# Host-safe A11 orchestration. Every SafeRide Python command runs in the pinned
# OCI image; this script uses only shell, files, hashes, locks, Docker, and
# nvidia-smi on the host.

IMAGE_ARCHIVE_SHA256="a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf"
IMAGE_ARCHIVE_SIZE="3350200320"
IMAGE_CONFIG_DIGEST="7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87"
MODEL_REVISION="70af34e20bd4b7a91f0de6b22675850c43922a03"
MINIMUM_FREE_VRAM_MIB=22000
LOCK_V054="/tmp/saferide-esh4198-v054-gpu.lock"
LOCK_V055="/tmp/saferide-esh4198-v055-gpu.lock"
LOCK_V056="/tmp/saferide-esh4198-v056-gpu.lock"
LOCK_V058="/tmp/saferide-esh4198-v058-gpu.lock"

fail() {
  printf 'SafeRide v0.5.8 A11 shell launcher blocked: %s\n' "$1" >&2
  exit 1
}

require_private_dir() {
  local directory="$1"
  local label="$2"
  test -d "$directory" && test ! -L "$directory" || fail "$label is unavailable or unsafe."
  test "$(stat -c '%a' "$directory")" = "700" || fail "$label must be mode 0700."
}

require_empty_private_dir() {
  require_private_dir "$1" "$2"
  test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" || fail "$2 must be newly empty."
}

require_safe_path() {
  local value="$1"
  local label="$2"
  case "$value" in
    /*) ;;
    *) fail "$label must be an absolute path." ;;
  esac
  case "$value" in
    *:*|*$'\n'*) fail "$label contains an unsafe mount character." ;;
  esac
}

sample_gpu() {
  local values
  values="$(nvidia-smi --id=0 --query-gpu=memory.total,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits)"
  IFS=',' read -r GPU_TOTAL GPU_FREE GPU_UTIL GPU_TEMP <<<"$values"
  GPU_TOTAL="${GPU_TOTAL// /}"
  GPU_FREE="${GPU_FREE// /}"
  GPU_UTIL="${GPU_UTIL// /}"
  GPU_TEMP="${GPU_TEMP// /}"
  mapfile -t GPU_PIDS < <(nvidia-smi --id=0 --query-compute-apps=pid --format=csv,noheader,nounits | awk '$1 ~ /^[0-9]+$/ {print $1}')
}

container_owns_pid() {
  local container_root_pid="$1"
  local candidate_pid="$2"
  local current="$candidate_pid"
  local parent
  local traversed=0
  while test "$current" -gt 1 && test "$traversed" -lt 256; do
    test "$current" = "$container_root_pid" && return 0
    test -r "/proc/$current/status" || return 1
    parent="$(awk '/^PPid:/ {print $2; exit}' "/proc/$current/status")"
    [[ "$parent" =~ ^[0-9]+$ ]] || return 1
    current="$parent"
    traversed=$((traversed + 1))
  done
  return 1
}

mode="${1:-}"
test "$mode" = "candidate" || test "$mode" = "development" || fail "Mode must be candidate or development."
shift

code_root=""
frozen_root=""
dev_data=""
panel_input=""
model_dir=""
image_archive=""
plan=""
output_root=""
checkpoint_root=""
evidence_root=""
adapter_root=""
candidate_metadata=""
paired_run_id=""
paired_run_metadata=""
run_id=""
container_name=""
screen_name=""
seed=""

while test "$#" -gt 0; do
  case "$1" in
    --code-root) code_root="$2"; shift 2 ;;
    --frozen-root) frozen_root="$2"; shift 2 ;;
    --dev-data) dev_data="$2"; shift 2 ;;
    --panel-input) panel_input="$2"; shift 2 ;;
    --model-dir) model_dir="$2"; shift 2 ;;
    --image-archive) image_archive="$2"; shift 2 ;;
    --plan) plan="$2"; shift 2 ;;
    --output-root) output_root="$2"; shift 2 ;;
    --checkpoint-root) checkpoint_root="$2"; shift 2 ;;
    --evidence-root) evidence_root="$2"; shift 2 ;;
    --adapter-root) adapter_root="$2"; shift 2 ;;
    --candidate-metadata) candidate_metadata="$2"; shift 2 ;;
    --paired-run-id) paired_run_id="$2"; shift 2 ;;
    --paired-run-metadata) paired_run_metadata="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --container-name) container_name="$2"; shift 2 ;;
    --screen-name) screen_name="$2"; shift 2 ;;
    --seed) seed="$2"; shift 2 ;;
    *) fail "Unknown or incomplete argument: $1" ;;
  esac
done

for binding in \
  "$code_root:Code root" "$model_dir:Pinned model root" "$image_archive:OCI archive" \
  "$plan:Candidate plan" "$output_root:Output root" "$evidence_root:Evidence root"; do
  require_safe_path "${binding%%:*}" "${binding#*:}"
done
require_private_dir "$code_root" "Code root"
require_private_dir "$model_dir" "Pinned model root"
require_empty_private_dir "$output_root" "Output root"
require_empty_private_dir "$evidence_root" "Evidence root"
test -f "$plan" && test ! -L "$plan" || fail "Candidate plan is unavailable or unsafe."
test -f "$image_archive" && test ! -L "$image_archive" || fail "Governed OCI archive is unavailable or unsafe."
test "$(stat -c '%s' "$image_archive")" = "$IMAGE_ARCHIVE_SIZE" || fail "Governed OCI archive size differs."
test "$(sha256sum "$image_archive" | awk '{print $1}')" = "$IMAGE_ARCHIVE_SHA256" || fail "Governed OCI archive hash differs."

image_record="$(docker image inspect "sha256:$IMAGE_CONFIG_DIGEST" --format '{{.Id}} {{index .Config.Labels "com.saferide.issue"}} {{index .Config.Labels "com.saferide.base-model-revision"}}')"
test "$image_record" = "sha256:$IMAGE_CONFIG_DIGEST ESH-4198 $MODEL_REVISION" || fail "Governed OCI image identity differs."
if docker container inspect "$container_name" >/dev/null 2>&1; then
  fail "Selected SafeRide container identity already exists."
fi

[[ "$seed" =~ ^41980[56]$ ]] || fail "Candidate seed differs."
if test "$mode" = "candidate"; then
  [[ "$run_id" =~ ^saferide-v058-candidate-s${seed}-[a-z0-9-]+$ ]] || fail "Candidate run identity differs."
  [[ "$container_name" =~ ^sr-v058-candidate-s${seed}-a11-[a-z0-9-]+$ ]] || fail "Candidate container identity differs."
  [[ "$screen_name" =~ ^sr-v058-candidate-s${seed}-[a-z0-9-]+$ ]] || fail "Candidate screen identity differs."
  for binding in "$frozen_root:Frozen input root" "$dev_data:Development input" "$checkpoint_root:Checkpoint root"; do
    require_safe_path "${binding%%:*}" "${binding#*:}"
  done
  require_private_dir "$frozen_root" "Frozen input root"
  test -f "$dev_data" && test ! -L "$dev_data" || fail "Development input is unavailable or unsafe."
  require_empty_private_dir "$checkpoint_root" "Checkpoint root"
  if test "$seed" = "419805"; then
    test -z "$paired_run_id" && test -z "$paired_run_metadata" || fail "Seed 419805 must not declare a predecessor."
  else
    test -n "$paired_run_id" && test -n "$paired_run_metadata" || fail "Seed 419806 requires its completed predecessor."
    require_safe_path "$paired_run_metadata" "Paired predecessor metadata"
    test -f "$paired_run_metadata" && test ! -L "$paired_run_metadata" || fail "Paired predecessor metadata is unavailable or unsafe."
  fi
else
  [[ "$run_id" =~ ^saferide-v058-development-s${seed}-[a-z0-9-]+$ ]] || fail "Development run identity differs."
  [[ "$container_name" =~ ^sr-v058-development-s${seed}-a11-[a-z0-9-]+$ ]] || fail "Development container identity differs."
  [[ "$screen_name" =~ ^sr-v058-development-s${seed}-[a-z0-9-]+$ ]] || fail "Development screen identity differs."
  for binding in "$panel_input:Panel input" "$adapter_root:Adapter root" "$candidate_metadata:Candidate metadata"; do
    require_safe_path "${binding%%:*}" "${binding#*:}"
  done
  require_private_dir "$panel_input" "Panel input"
  require_private_dir "$adapter_root" "Adapter root"
  test -f "$candidate_metadata" && test ! -L "$candidate_metadata" || fail "Candidate metadata is unavailable or unsafe."
fi

exec 9>"$LOCK_V054"
exec 8>"$LOCK_V055"
exec 7>"$LOCK_V056"
exec 6>"$LOCK_V058"
flock -n 9 || fail "SafeRide v0.5.4 GPU lock is held."
flock -n 8 || fail "SafeRide v0.5.5 GPU lock is held."
flock -n 7 || fail "SafeRide v0.5.6 GPU lock is held."
flock -n 6 || fail "SafeRide v0.5.8 GPU lock is held."

minimum_free=999999
peak_utilization=0
maximum_temperature=0
maximum_processes=0
admission_started="$(date +%s)"
for sample_index in $(seq 1 16); do
  sample_gpu
  test "$GPU_FREE" -lt "$minimum_free" && minimum_free="$GPU_FREE" || true
  test "$GPU_UTIL" -gt "$peak_utilization" && peak_utilization="$GPU_UTIL" || true
  test "$GPU_TEMP" -gt "$maximum_temperature" && maximum_temperature="$GPU_TEMP" || true
  test "${#GPU_PIDS[@]}" -gt "$maximum_processes" && maximum_processes="${#GPU_PIDS[@]}" || true
  test "$sample_index" -eq 16 || sleep 2
done
admission_duration=$(( $(date +%s) - admission_started ))
test "$admission_duration" -ge 30 || fail "A11 admission duration differs."
test "$minimum_free" -ge "$MINIMUM_FREE_VRAM_MIB" || fail "A11 admission free VRAM is below the gate."
test "$maximum_processes" -eq 0 || fail "A11 admission found an existing compute process."
captured_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '{"status":"passed","capturedAt":"%s","sampleCount":16,"durationSeconds":%s,"minimumFreeVramMiB":%s,"totalVramMiB":%s,"maximumComputeProcessCount":0,"peakUtilizationPercent":%s,"maximumTemperatureC":%s,"safeRideExclusiveLocksAcquired":4}\n' \
  "$captured_at" "$admission_duration" "$minimum_free" "$GPU_TOTAL" "$peak_utilization" "$maximum_temperature" \
  >"$evidence_root/host-gpu-admission.json"
chmod 600 "$evidence_root/host-gpu-admission.json"

docker_command=(
  docker run --rm --pull never --name "$container_name"
  --network none --gpus device=0 --read-only --cpus 16 --memory 96g
  --pids-limit 4096 --shm-size 16g --user "$(id -u):$(id -g)"
  --tmpfs /tmp:rw,nosuid,noexec,size=8g,mode=1777
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e HF_DATASETS_OFFLINE=1
  -e TOKENIZERS_PARALLELISM=false -e PYTHONDONTWRITEBYTECODE=1
  -v "$code_root:/workspace:ro" -v "$model_dir:/model:ro" -v "$plan:/inputs/plan.json:ro"
)
if test "$mode" = "candidate"; then
  docker_command+=(
    -v "$frozen_root:/inputs/frozen:ro" -v "$dev_data:/inputs/original-development.jsonl:ro"
    -v "$output_root:/outputs:rw" -v "$checkpoint_root:/checkpoints:rw"
  )
  paired_arguments=()
  if test "$seed" = "419806"; then
    docker_command+=(-v "$paired_run_metadata:/inputs/predecessor.json:ro")
    paired_arguments=(--paired-run-id "$paired_run_id" --paired-run-metadata /inputs/predecessor.json)
  fi
  docker_command+=(
    --entrypoint python "sha256:$IMAGE_CONFIG_DIGEST"
    /workspace/scripts/saferide-gemma4-v058-finetune-runner.py run
    --frozen-root /inputs/frozen --dev-data /inputs/original-development.jsonl
    --base-model-path /model --plan /inputs/plan.json --output-root /outputs
    --checkpoint-root /checkpoints --run-id "$run_id" --seed "$seed"
    "${paired_arguments[@]}"
  )
else
  docker_command+=(
    -e "SAFERIDE_PANEL_IMAGE_CONFIG_DIGEST=$IMAGE_CONFIG_DIGEST"
    -v "$panel_input:/inputs/panel:ro" -v "$adapter_root:/adapter:ro"
    -v "$candidate_metadata:/inputs/candidate-metadata.json:ro" -v "$output_root:/outputs:rw"
    --entrypoint python "sha256:$IMAGE_CONFIG_DIGEST"
    /workspace/scripts/saferide-gemma4-v058-development-panel.py run-and-verify
    --panel-input /inputs/panel --model-root /model --adapter-root /adapter
    --candidate-metadata /inputs/candidate-metadata.json --plan /inputs/plan.json
    --output-root /outputs
  )
fi

container_log="$evidence_root/container.private.log"
monitor_started="$(date +%s)"
minimum_running_free=999999
peak_running_utilization=0
maximum_running_processes=0
competing_process_observed=false
docker_client_pid=""

stop_owned_container() {
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    docker stop --time 20 "$container_name" >/dev/null 2>&1 || true
  fi
}
trap stop_owned_container EXIT HUP INT TERM

"${docker_command[@]}" >"$container_log" 2>&1 &
docker_client_pid="$!"
chmod 600 "$container_log"
while kill -0 "$docker_client_pid" >/dev/null 2>&1; do
  sleep 5
  sample_gpu
  test "$GPU_FREE" -lt "$minimum_running_free" && minimum_running_free="$GPU_FREE" || true
  test "$GPU_UTIL" -gt "$peak_running_utilization" && peak_running_utilization="$GPU_UTIL" || true
  test "${#GPU_PIDS[@]}" -gt "$maximum_running_processes" && maximum_running_processes="${#GPU_PIDS[@]}" || true
  if test "${#GPU_PIDS[@]}" -gt 0; then
    container_root_pid="$(docker container inspect --format '{{.State.Pid}}' "$container_name" 2>/dev/null || true)"
    [[ "$container_root_pid" =~ ^[1-9][0-9]*$ ]] || competing_process_observed=true
    if test "$competing_process_observed" = false; then
      for gpu_pid in "${GPU_PIDS[@]}"; do
        if ! container_owns_pid "$container_root_pid" "$gpu_pid"; then
          competing_process_observed=true
          break
        fi
      done
    fi
    if test "$competing_process_observed" = true; then
      stop_owned_container
      break
    fi
  fi
done

set +e
wait "$docker_client_pid"
container_exit_code="$?"
set -e
test "$competing_process_observed" = false || fail "A competing GPU process appeared; only this SafeRide container was stopped."
test "$container_exit_code" -eq 0 || fail "SafeRide $mode container exited unsuccessfully."

final_idle=false
for final_index in $(seq 1 12); do
  sample_gpu
  if test "${#GPU_PIDS[@]}" -eq 0 && test "$GPU_FREE" -ge "$MINIMUM_FREE_VRAM_MIB"; then
    final_idle=true
    break
  fi
  test "$final_index" -eq 12 || sleep 5
done
test "$final_idle" = true || fail "A11 did not return to the required idle state."
finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
wall_seconds=$(( $(date +%s) - monitor_started ))
test "$minimum_running_free" -ne 999999 || minimum_running_free="$GPU_FREE"
printf '{"schema":"com.saferide.ai.v058-a11-shell-monitor","schemaVersion":1,"status":"completed","mode":"%s","screenName":"%s","runId":"%s","seed":%s,"finishedAt":"%s","wallSeconds":%s,"containerExitCode":0,"maximumComputeProcessCount":%s,"minimumFreeVramMiBWhileRunning":%s,"peakUtilizationPercent":%s,"competingWorkloadObserved":false,"finalA11State":{"totalVramMiB":%s,"freeVramMiB":%s,"utilizationPercent":%s,"temperatureC":%s,"computeProcessCount":0},"privacy":{"rawContentIncluded":false,"privatePathsIncluded":false,"holdoutRowsRead":0},"selectionPerformed":false,"promotionPerformed":false}\n' \
  "$mode" "$screen_name" "$run_id" "$seed" "$finished_at" "$wall_seconds" \
  "$maximum_running_processes" "$minimum_running_free" "$peak_running_utilization" \
  "$GPU_TOTAL" "$GPU_FREE" "$GPU_UTIL" "$GPU_TEMP" >"$evidence_root/host-monitor.json"
chmod 600 "$evidence_root/host-monitor.json"
trap - EXIT HUP INT TERM
printf 'SafeRide v0.5.8 A11 shell launch PASS (mode=%s; seed=%s; screen=%s; A11 idle).\n' "$mode" "$seed" "$screen_name"
