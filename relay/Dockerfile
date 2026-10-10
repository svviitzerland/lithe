FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /lithe-relay .

FROM gcr.io/distroless/static-debian12
COPY --from=build /lithe-relay /lithe-relay
EXPOSE 2222
ENTRYPOINT ["/lithe-relay", "--addr", ":2222"]
