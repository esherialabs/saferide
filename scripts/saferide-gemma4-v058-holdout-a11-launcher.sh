#!/usr/bin/env bash
set -euo pipefail

# Host-safe orchestration for the one leadership-authorized v0.5.8 holdout.
# SafeRide Python runs only inside the pinned offline OCI image.

IMAGE_ARCHIVE_SHA256="a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf"
IMAGE_ARCHIVE_SIZE="3350200320"
IMAGE_CONFIG_DIGEST="7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87"
MODEL_REVISION="70af34e20bd4b7a91f0de6b22675850c43922a03"
HOLDOUT_SHA256="6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4"
HOLDOUT_SIZE="68930"
SELECTED_METADATA_SHA256="5334c8f274570bf18743b76869c90adfcbfb62c9bffaf90d5adf87a5712ef823"
MINIMUM_FREE_VRAM_MIB=22000
LOCK_V054="/tmp/saferide-esh4198-v054-gpu.lock"
LOCK_V055="/tmp/saferide-esh4198-v055-gpu.lock"
LOCK_V056="/tmp/saferide-esh4198-v056-gpu.lock"
LOCK_V058="/tmp/saferide-esh4198-v058-gpu.lock"
LOCK_HOLDOUT="/tmp/saferide-esh4198-v058-holdout-once.lock"

fail() {
  printf 'SafeRide v0.5.8 one-time holdout launcher blocked: %s\n' "$1" >&2
  exit 1
}

require_safe_path() {
  local value="$1"
  local label="$2"
  case "$value" in /*) ;; *) fail "$label must be an absolute path." ;; esac
  case "$value" in *:*|*$'\n'*) fail "$label contains an unsafe mount character." ;; esac
}

require_private_dir() {
  test -d "$1" && test ! -L "$1" || fail "$2 is unavailable or unsafe."
  case "$(stat -c '%a' "$1")" in 700|500) ;; *) fail "$2 must be private." ;; esac
}

require_empty_private_dir() {
  require_private_dir "$1" "$2"
  test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" || fail "$2 must be newly empty."
}

require_file() {
  test -f "$1" && test ! -L "$1" || fail "$2 is unavailable or unsafe."
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
  local current="$2"
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

code_root=""
model_dir=""
image_archive=""
adapter_root=""
candidate_metadata=""
input_root=""
output_root=""
evidence_root=""
run_id=""
container_name=""
while test "$#" -gt 0; do
  case "$1" in
    --code-root) code_root="$2"; shift 2 ;;
    --model-dir) model_dir="$2"; shift 2 ;;
    --image-archive) image_archive="$2"; shift 2 ;;
    --adapter-root) adapter_root="$2"; shift 2 ;;
    --candidate-metadata) candidate_metadata="$2"; shift 2 ;;
    --input-root) input_root="$2"; shift 2 ;;
    --output-root) output_root="$2"; shift 2 ;;
    --evidence-root) evidence_root="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --container-name) container_name="$2"; shift 2 ;;
    *) fail "Unknown or incomplete argument: $1" ;;
  esac
done

for binding in \
  "$code_root:Code root" "$model_dir:Pinned model root" "$image_archive:OCI archive" \
  "$adapter_root:Selected adapter" "$candidate_metadata:Selected metadata" \
  "$input_root:One-time input" "$output_root:Holdout output" "$evidence_root:Host evidence"; do
  require_safe_path "${binding%%:*}" "${binding#*:}"
done
require_private_dir "$code_root" "Code root"
require_private_dir "$model_dir" "Pinned model root"
require_private_dir "$adapter_root" "Selected adapter"
require_private_dir "$input_root" "One-time input"
require_empty_private_dir "$output_root" "Holdout output"
require_empty_private_dir "$evidence_root" "Host evidence"
require_file "$image_archive" "Governed OCI archive"
require_file "$candidate_metadata" "Selected metadata"
require_file "$input_root/leadership-selection.json" "Leadership selection"
require_file "$input_root/one-time-access-receipt.json" "One-time access receipt"
require_file "$input_root/mitigation-holdout.sealed.private.jsonl" "Sealed holdout"
require_file "$code_root/scripts/saferide-gemma4-v058-leadership-release.py" "Leadership evaluator"
require_file "$code_root/scripts/saferide-gemma4-v057-pilot-panel.py" "Frozen panel dependency"
test "$(stat -c '%s' "$image_archive")" = "$IMAGE_ARCHIVE_SIZE" || fail "Governed OCI archive size differs."
test "$(sha256sum "$image_archive" | awk '{print $1}')" = "$IMAGE_ARCHIVE_SHA256" || fail "Governed OCI archive hash differs."
test "$(sha256sum "$candidate_metadata" | awk '{print $1}')" = "$SELECTED_METADATA_SHA256" || fail "Selected metadata hash differs."
test "$(stat -c '%s' "$input_root/mitigation-holdout.sealed.private.jsonl")" = "$HOLDOUT_SIZE" || fail "Sealed holdout size differs."
test "$(sha256sum "$input_root/mitigation-holdout.sealed.private.jsonl" | awk '{print $1}')" = "$HOLDOUT_SHA256" || fail "Sealed holdout hash differs."
test "$(stat -c '%a' "$input_root/one-time-access-receipt.json")" = 400 || fail "One-time access receipt is not immutable."
test "$(jq -r '.codeBinding.leadershipReleaseScriptSha256' "$input_root/leadership-selection.json")" = "$(sha256sum "$code_root/scripts/saferide-gemma4-v058-leadership-release.py" | awk '{print $1}')" || fail "Leadership evaluator binding differs."
test "$(jq -r '.codeBinding.holdoutLauncherSha256' "$input_root/leadership-selection.json")" = "$(sha256sum "$0" | awk '{print $1}')" || fail "Holdout launcher binding differs."

image_record="$(docker image inspect "sha256:$IMAGE_CONFIG_DIGEST" --format '{{.Id}} {{index .Config.Labels "com.saferide.issue"}} {{index .Config.Labels "com.saferide.base-model-revision"}}')"
test "$image_record" = "sha256:$IMAGE_CONFIG_DIGEST ESH-4198 $MODEL_REVISION" || fail "Governed OCI image identity differs."
[[ "$run_id" =~ ^saferide-v058-holdout-original-s419806-[a-z0-9-]+$ ]] || fail "Holdout run identity differs."
[[ "$container_name" =~ ^sr-v058-holdout-original-s419806-a11-[a-z0-9-]+$ ]] || fail "Holdout container identity differs."
docker container inspect "$container_name" >/dev/null 2>&1 && fail "Holdout container identity already exists."

exec 9>"$LOCK_V054"
exec 8>"$LOCK_V055"
exec 7>"$LOCK_V056"
exec 6>"$LOCK_V058"
exec 5>"$LOCK_HOLDOUT"
cleanup_lock() {
  flock -u 5 >/dev/null 2>&1 || true
  exec 5>&-
  test ! -e "$LOCK_HOLDOUT" || unlink -- "$LOCK_HOLDOUT"
}
trap cleanup_lock EXIT HUP INT TERM
flock -n 9 || fail "SafeRide v0.5.4 GPU lock is held."
flock -n 8 || fail "SafeRide v0.5.5 GPU lock is held."
flock -n 7 || fail "SafeRide v0.5.6 GPU lock is held."
flock -n 6 || fail "SafeRide v0.5.8 GPU lock is held."
flock -n 5 || fail "The one-time holdout lock is held."

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
printf '{"schema":"com.saferide.ai.v058-holdout-a11-admission","schemaVersion":1,"status":"passed","capturedAt":"%s","sampleCount":16,"durationSeconds":%s,"minimumFreeVramMiB":%s,"totalVramMiB":%s,"maximumComputeProcessCount":0,"peakUtilizationPercent":%s,"maximumTemperatureC":%s,"safeRideExclusiveLocksAcquired":5}\n' \
  "$captured_at" "$admission_duration" "$minimum_free" "$GPU_TOTAL" "$peak_utilization" "$maximum_temperature" \
  >"$evidence_root/host-gpu-admission.json"
chmod 600 "$evidence_root/host-gpu-admission.json"

container_log="$evidence_root/container.private.log"
docker_command=(
  docker run --rm --pull never --name "$container_name"
  --network none --gpus device=0 --read-only --cpus 16 --memory 96g
  --pids-limit 4096 --shm-size 16g --user "$(id -u):$(id -g)"
  --tmpfs /tmp:rw,nosuid,noexec,size=8g,mode=1777
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e HF_DATASETS_OFFLINE=1
  -e TOKENIZERS_PARALLELISM=false -e PYTHONDONTWRITEBYTECODE=1
  -e "SAFERIDE_IMAGE_CONFIG_DIGEST=$IMAGE_CONFIG_DIGEST"
  -v "$code_root:/workspace:ro" -v "$model_dir:/model:ro"
  -v "$adapter_root:/adapter:ro" -v "$candidate_metadata:/inputs/candidate-metadata.json:ro"
  -v "$input_root:/inputs/one-time:ro" -v "$output_root:/outputs:rw"
  --entrypoint python "sha256:$IMAGE_CONFIG_DIGEST"
  /workspace/scripts/saferide-gemma4-v058-leadership-release.py evaluate
  --selection /inputs/one-time/leadership-selection.json
  --access-receipt /inputs/one-time/one-time-access-receipt.json
  --holdout /inputs/one-time/mitigation-holdout.sealed.private.jsonl
  --model-root /model --adapter-root /adapter
  --candidate-metadata /inputs/candidate-metadata.json
  --v057-panel /workspace/scripts/saferide-gemma4-v057-pilot-panel.py
  --output-root /outputs
)

stop_owned_container() {
  docker container inspect "$container_name" >/dev/null 2>&1 && docker stop --time 20 "$container_name" >/dev/null 2>&1 || true
}
trap 'stop_owned_container; cleanup_lock' EXIT HUP INT TERM
started_epoch="$(date +%s)"
"${docker_command[@]}" >"$container_log" 2>&1 &
docker_client_pid="$!"
chmod 600 "$container_log"
minimum_running_free=999999
peak_running_utilization=0
maximum_running_processes=0
competing_process_observed=false
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
        container_owns_pid "$container_root_pid" "$gpu_pid" || competing_process_observed=true
      done
    fi
    if test "$competing_process_observed" = true; then stop_owned_container; break; fi
  fi
done
set +e
wait "$docker_client_pid"
container_exit_code="$?"
set -e
test "$competing_process_observed" = false || fail "A competing GPU process appeared; only the owned container was stopped."
final_idle=false
for final_index in $(seq 1 12); do
  sample_gpu
  if test "${#GPU_PIDS[@]}" -eq 0 && test "$GPU_UTIL" -eq 0 && test "$GPU_FREE" -ge "$MINIMUM_FREE_VRAM_MIB"; then
    final_idle=true
    break
  fi
  sleep 5
done
test "$final_idle" = true || fail "A11 did not return to the required idle state."
docker container inspect "$container_name" >/dev/null 2>&1 && fail "Owned holdout container remains present."
finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
wall_seconds=$(( $(date +%s) - started_epoch ))
printf '{"schema":"com.saferide.ai.v058-holdout-a11-monitor","schemaVersion":1,"status":"completed-and-idle","runId":"%s","finishedAt":"%s","wallSeconds":%s,"containerExitCode":%s,"maximumComputeProcessCount":%s,"minimumFreeVramMiBWhileRunning":%s,"peakUtilizationPercent":%s,"competingWorkloadObserved":false,"finalA11State":{"totalVramMiB":%s,"freeVramMiB":%s,"utilizationPercent":%s,"temperatureC":%s,"computeProcessCount":0},"privacy":{"rawContentIncluded":false,"privatePathsIncluded":false,"rawPromptOrCompletionLogging":false},"controlledEvaluatorRuns":1,"trainingRuns":0,"continuationRuns":0,"developmentPanelRuns":0,"modelDownloads":0,"awsOperations":0}\n' \
  "$run_id" "$finished_at" "$wall_seconds" "$container_exit_code" "$maximum_running_processes" "$minimum_running_free" "$peak_running_utilization" \
  "$GPU_TOTAL" "$GPU_FREE" "$GPU_UTIL" "$GPU_TEMP" >"$evidence_root/host-gpu-monitor.json"
chmod 600 "$evidence_root/host-gpu-monitor.json"
trap - EXIT HUP INT TERM
cleanup_lock
if test "$container_exit_code" -eq 2; then
  printf 'SafeRide v0.5.8 one-time holdout REJECTED fail-closed (A11 idle; controlledEvaluatorRuns=1).\n' >&2
  exit 2
fi
test "$container_exit_code" -eq 0 || fail "One-time holdout container exited unsuccessfully after A11 returned idle."
printf 'SafeRide v0.5.8 one-time holdout launch PASS (A11 idle; controlledEvaluatorRuns=1).\n'
