#!/usr/bin/env bash
#
# A wrapper for the common Docker commands.
#
#   ./deploy.sh up          build and start the API
#   ./deploy.sh down        stop it
#   ./deploy.sh logs        follow the log
#   ./deploy.sh health      ask the API how it is doing
#   ./deploy.sh test        send a page through the API and check the result
#   ./deploy.sh gpu up      the same, with the CUDA image
#   ./deploy.sh tls up      the same, behind an HTTPS proxy
#
# The Docker daemon has to be reachable. On Linux that means the user has to
# be in the "docker" group.

set -euo pipefail

# The folder this script lives in, and the repository root above it.
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${DEPLOY_DIR}/.." && pwd)"

COMPOSE_FILES=("${DEPLOY_DIR}/docker-compose.yml")
USE_GPU=0
USE_TLS=0

# Read the command and its options.
COMMAND="${1:-up}"
shift || true

for option in "$@"; do
	case "${option}" in
		gpu) USE_GPU=1 ;;
		tls) USE_TLS=1 ;;
		*) echo "unknown option: ${option}" >&2; exit 2 ;;
	esac
done

if [ "${USE_TLS}" -eq 1 ]; then
	COMPOSE_FILES+=("${DEPLOY_DIR}/docker-compose.tls.yml")
fi

if [ "${USE_GPU}" -eq 1 ]; then
	COMPOSE_FILES+=("${DEPLOY_DIR}/docker-compose.gpu.yml")
fi

compose() {
	docker compose --project-directory "${DEPLOY_DIR}" "${COMPOSE_FILES[@]}" "$@"
}

# The domain is needed by the TLS stack, and the token by everything.
require_env() {
	if [ ! -f "${DEPLOY_DIR}/.env" ]; then
		echo "deploy/.env is missing. Copy deploy/.env.example to deploy/.env first." >&2
		exit 1
	fi
}

# The Docker socket belongs to the "docker" group, and a user outside that
# group gets "permission denied" from every command. The check runs before
# the first Docker call, so the message explains the fix instead of leaving
# the raw socket error on its own.
require_docker_access() {
	if docker info > /dev/null 2>&1; then
		return 0
	fi

	local error
	# The whole output is captured, because cutting it with "head" closes the
	# pipe early and Docker then dies from a broken pipe.
	error="$(docker info 2>&1 || true)"
	if ! printf '%s' "${error}" | grep -qi "permission denied"; then
		# A different problem, such as the daemon not running. Let Docker
		# report it itself.
		return 0
	fi

	echo "This account cannot talk to the Docker daemon." >&2
	echo "" >&2
	echo "The socket belongs to the \"docker\" group:" >&2
	echo "  $(ls -l /var/run/docker.sock 2>/dev/null || echo '/var/run/docker.sock is missing')" >&2
	echo "" >&2
	echo "Add this account to the group:" >&2
	echo "  sudo usermod -aG docker ${USER}" >&2
	echo "" >&2
	echo "Then log out and back in, so the new group is picked up." >&2
	echo "To try it without logging out:" >&2
	echo "  newgrp docker" >&2
	exit 1
}

case "${COMMAND}" in
	up)
		require_docker_access
		require_env
		compose up --build -d
		echo "The API is on http://127.0.0.1:8001"
		echo "Follow the log with: ./deploy.sh logs"
		;;
	down)
		require_docker_access
		compose down
		;;
	logs)
		require_docker_access
		compose logs -f api
		;;
	health)
		curl --fail --silent --show-error http://127.0.0.1:8001/health
		echo
		;;
	ps)
		require_docker_access
		compose ps
		;;
	build)
		require_docker_access
		compose build
		;;
	test)
		require_docker_access
		# The page is sent to the running server and the saliency map in the
		# answer is measured. Set PAGE to a PNG of a full web page.
		PAGE="${PAGE:-/tmp/page.png}"
		if [ ! -f "${PAGE}" ]; then
			echo "No page at ${PAGE}." >&2
			echo "Capture one with: node scripts/capture-page.mjs <url> ${PAGE}" >&2
			exit 1
		fi
		if [ -x "${ROOT_DIR}/backend/.venv/bin/python" ]; then
			"${ROOT_DIR}/backend/.venv/bin/python" "${ROOT_DIR}/scripts/check-server-bands.py" \
				--page "${PAGE}" --url http://127.0.0.1:8001
		else
			# Without a local environment the check runs inside the
			# container, which has numpy and Pillow. The page is copied in
			# first, because the container cannot see the host's files.
			compose cp "${PAGE}" api:/tmp/page.png
			compose exec -T api python /app/scripts/check-server-bands.py \
				--page /tmp/page.png --url http://127.0.0.1:8001
		fi
		;;
	*)
		echo "usage: ${0} {up|down|logs|health|ps|build|test} [gpu] [tls]" >&2
		exit 2
		;;
esac
