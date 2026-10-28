# Deploying LookAtify

Everything for a Docker deployment lives in this folder. The backend is the
only part that runs as a service — the browser extension is installed in the
browser and talks to the API over HTTP.

```
deploy/
├── Dockerfile              the CPU image
├── Dockerfile.gpu          the CUDA image
├── docker-compose.yml      the stack
├── docker-compose.gpu.yml  the stack with the GPU image
├── docker-compose.tls.yml  the stack behind an HTTPS proxy
├── Caddyfile               the reverse proxy's configuration
├── .env.example            the settings to copy to .env
└── deploy.sh               a wrapper for the common commands
```

## The quick way

```bash
cd deploy
cp .env.example .env
./deploy.sh up
```

The API is then on <http://127.0.0.1:8001>, and
<http://127.0.0.1:8001/health> reports the model and the device it runs on.

The first start downloads the DeepGaze weights (about 400 MB) into the
`model-cache` volume. The download happens once; later starts reuse it. The
health check waits 180 seconds for this, so a fresh container looks
unhealthy for a while before it becomes ready.

## The steps by hand

```bash
# Build and start.
docker compose -f deploy/docker-compose.yml up --build -d

# Follow the log.
docker compose -f deploy/docker-compose.yml logs -f api

# Check that the model is loaded.
curl http://127.0.0.1:8001/health

# Stop, and remove the container but keep the weights.
docker compose -f deploy/docker-compose.yml down
```

## The settings

`deploy/.env` holds the settings. The ones that matter most:

| Setting | Meaning |
|---|---|
| `API_TOKEN` | The token the extension has to send. Empty means no token. |
| `CORS_ORIGINS` | The origins that may call the API, as regular expressions. |
| `MODEL_NAME` | `deepgaze2e`, `deepgaze3` or `deepgaze1`. |
| `DEVICE` | `auto`, `cpu` or `cuda`. |
| `OMP_NUM_THREADS` | The threads the model uses on the CPU. |

### The token

Without a token anyone who can reach the port can use the service. Set one
before the server is reachable from outside the machine:

```bash
openssl rand -hex 32
```

Put the value in `deploy/.env` as `API_TOKEN`, and put the same value in the
extension's settings (the *API token* field on the options page).

### The origins

The API matches the origin of a request against `CORS_ORIGINS` literally, so
a plain `*` does **not** work. The default accepts any Chrome or Firefox
extension:

```
chrome-extension://[a-p]{32},moz-extension://[0-9a-f\-]{36}
```

Add your own origins as comma separated regular expressions.

## A server on another machine

The browser extension refuses to talk to a remote server over plain HTTP, so
a deployment that is not on the same machine as the browser needs HTTPS. The
TLS overlay adds a Caddy proxy that obtains the certificate on its own:

```bash
cd deploy
cp .env.example .env
echo "LOOKATIFY_DOMAIN=heatmaps.example.com" >> .env
echo "ACME_EMAIL=you@example.com" >> .env
docker compose -f docker-compose.yml -f docker-compose.tls.yml up --build -d
```

The domain has to point at the host, and ports 80 and 443 have to be open.
The certificate is issued automatically and renewed automatically.

The API is then on `https://heatmaps.example.com`, and the extension's
*Server URL* is set to the same address.

## A machine with a GPU

The GPU image uses the CUDA build of torch:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.gpu.yml up --build -d
```

It needs the NVIDIA Container Toolkit on the host, and it asks the container
for the GPU through the `deploy.resources.reservations.devices` block. The
`/health` endpoint then reports `"device": "cuda"`.

The pinned torch wheel carries its own CUDA libraries, so the image does not
install a separate CUDA build of torch. The base image's CUDA version
(13.0.3) matches the one the wheel expects, so the container and the host
driver agree. A host driver that is too old for CUDA 13 cannot run this
image.

## The resources

The model needs about 4 GB of memory: the weights are held in RAM, and a
long page adds its own saliency map. The compose file caps the container at
6 GB.

On the CPU, a 1440 × 14052 page takes about 80 seconds. On a GPU it is
much faster.

## The images

```bash
# Build without starting.
docker compose -f deploy/docker-compose.yml build

# Tag for a registry.
docker tag lookatify/backend:0.1.0 registry.example.com/lookatify/backend:0.1.0
docker push registry.example.com/lookatify/backend:0.1.0
```

The build context is the repository root, so the image can be built from
anywhere:

```bash
docker build -f deploy/Dockerfile -t lookatify/backend:0.1.0 .
```

## Troubleshooting

**`permission denied while trying to connect to the Docker daemon socket`.**
The socket belongs to the `docker` group, and the account has to be in it.
This is the one thing a Docker setup cannot do without root:

```bash
sudo usermod -aG docker $USER
```

Then log out and back in, so the shell picks up the new group. To try it
without logging out, run `newgrp docker` first and then the Docker command
in that shell. Check the result with `docker info`.

`./deploy.sh` checks this before its first Docker call and prints the same
instructions, so the message never turns into a raw socket error.

**The container stays unhealthy.** The first start downloads 400 MB of
weights. Watch the log: `docker compose -f deploy/docker-compose.yml logs -f api`.
The line `Model ready` appears when the weights are in place.

**`Cannot reach the analysis server`.** The extension cannot connect. Check
`/health` from the host, and check that the extension's *Server URL* points
at the right address.

**The browser sends the request and the API answers 403.** The origin is
not in `CORS_ORIGINS`. The extension's origin looks like
`chrome-extension://aopijfmlmmeohbnnnnnnnnnnnnnn`, and it changes when the
extension is reloaded, so the default uses a pattern.

**The port is already in use.** The API checks the port at startup and
refuses to start. Change `PORT` in `deploy/.env` and the published port in
`deploy/docker-compose.yml`.
