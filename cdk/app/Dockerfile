# Initial package install
FROM --platform=linux/amd64 node:14 AS build
WORKDIR /srv
ADD package.json .
ADD index.js .
RUN npm install

# Actual runtime image
FROM --platform=linux/amd64 node:14-slim
COPY --from=build /srv .
ARG TARGETPLATFORM
RUN echo "Building for $TARGETPLATFORM"
ADD . .
EXPOSE 3000
EXPOSE 80
COPY index.html /usr/share/nginx/html
