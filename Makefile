BUN ?= bun
BIN ?= ffmpegb
ENTRY := src/cli.ts

.PHONY: all build test bench verify clean

all: build

build:
	$(BUN) run scripts/generate-assets.ts
	$(BUN) build --compile $(ENTRY) --outfile $(BIN)

test:
	$(BUN) run test

bench:
	$(BUN) run bench

verify: test bench build
	mkdir -p scratch/standalone
	cp $(BIN) scratch/standalone/$(BIN)
	cd scratch/standalone && ./$(BIN) -y -i ../../test/test_video.mp4 -t 1 smoke.mp4
	@test -s scratch/standalone/smoke.mp4

clean:
	rm -f $(BIN)
	rm -rf scratch/standalone scratch/bench
