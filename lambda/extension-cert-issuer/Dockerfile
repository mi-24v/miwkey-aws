# Node 24.21.0 / AL2023, resolved and tested on linux/amd64.
FROM public.ecr.aws/lambda/nodejs@sha256:6a2bf271bdb996645b570e35ba9ed777dfb9845b801fc7ab4ac32849d2aea3c4 AS runtime
RUN dnf install -y openssl-1:3.5.8-1.amzn2023.0.1 && dnf clean all \
    && echo '29c3c09e80e1984234c707266e3242cf982c27633aab896166b857442d2ce835  /usr/bin/openssl' | sha256sum -c - \
    && echo 'eb1a3d62632402276c11915f51c56e948ed6a0825b4c032dd67eaa77992a72e3  /usr/lib64/libssl.so.3' | sha256sum -c - \
    && echo '2a24df5a4ae572b4c6a0ceab0cd866ce23717cb6dcaabfc3cf679039ba4d31fd  /usr/lib64/libcrypto.so.3' | sha256sum -c - \
    && env -u LD_LIBRARY_PATH OPENSSL_CONF=/dev/null /usr/bin/openssl version
FROM runtime AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY vendor/acme-client-native/acme-client-native-5.4.0-miwkey.1.tgz vendor/acme-client-native/acme-client-native-5.4.0-miwkey.1.tgz
COPY lambda/extension-cert-issuer/package.json lambda/extension-cert-issuer/package.json
RUN npm ci --ignore-scripts --workspace @miwkey/extension-cert-issuer --include-workspace-root=false
COPY lambda/extension-cert-issuer/tsconfig.json lambda/extension-cert-issuer/tsconfig.json
COPY lambda/extension-cert-issuer/src lambda/extension-cert-issuer/src
RUN npm run build --workspace @miwkey/extension-cert-issuer
FROM runtime AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
COPY vendor/acme-client-native/acme-client-native-5.4.0-miwkey.1.tgz vendor/acme-client-native/acme-client-native-5.4.0-miwkey.1.tgz
COPY lambda/extension-cert-issuer/package.json lambda/extension-cert-issuer/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @miwkey/extension-cert-issuer --include-workspace-root=false
FROM runtime
COPY --from=dependencies /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=dependencies /build/lambda ${LAMBDA_TASK_ROOT}/lambda
COPY --from=build /build/lambda/extension-cert-issuer/dist ${LAMBDA_TASK_ROOT}/lambda/extension-cert-issuer/dist
COPY lambda/extension-cert-issuer/public-roots.pem lambda/extension-cert-issuer/staging-roots.pem lambda/extension-cert-issuer/trust.json lambda/extension-cert-issuer/runtime-pins.json ${LAMBDA_TASK_ROOT}/lambda/extension-cert-issuer/
CMD ["lambda/extension-cert-issuer/dist/handler.handler"]
