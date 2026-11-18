FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils
RUN curl --fail --silent --show-error --location https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-arm64.tar.xz --output /tmp/node.tar.xz \
    && echo '7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c  /tmp/node.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local
CMD ["sleep", "600"]
