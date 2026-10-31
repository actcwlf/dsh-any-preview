/**
 * Freestanding decode module: no libc, no emscripten runtime.
 *
 * The browser hands over one packed block; this module only decodes. Because the
 * build is `-nostdlib`, the two functions libc would normally provide (memcpy and
 * memset) and a tiny bump allocator live here. `reset_heap` rewinds the allocator,
 * which is safe because a decode call allocates, decodes and frees in one go.
 */
#include <stdint.h>
#include "LzmaDec.h"
#include "Lzma2Dec.h"
#include "Bra.h"
#include "Delta.h"


/* ---- errno -------------------------------------------------------------- */

static int g_errno = 0;

int *__errno_location(void) {
  return &g_errno;
}

/* ---- allocator ---------------------------------------------------------- */

/* The heap starts at __heap_base and grows on demand; nothing is reserved up
 * front. Pointers are wasm offsets, so memory.grow cannot invalidate them. */
extern unsigned char __heap_base;

static uint32_t g_used = 0;

static uint32_t heap_bytes(void) {
  return (uint32_t)__builtin_wasm_memory_size(0) * 65536u
       - (uint32_t)(uintptr_t)&__heap_base;
}

static int heap_reserve(uint32_t need) {
  if (need <= heap_bytes()) return 1;
  uint32_t missing = need - heap_bytes();
  size_t pages = (missing + 65535u) / 65536u;
  return __builtin_wasm_memory_grow(0, pages) != (size_t)-1;
}

void reset_heap(void) {
  g_used = 0;
}

void *malloc(size_t size) {
  uint32_t aligned = (uint32_t)((size + 15u) & ~(size_t)15u);
  if (aligned == 0) aligned = 16u;
  if (!heap_reserve(g_used + aligned)) return 0;
  void *result = &__heap_base + g_used;
  g_used += aligned;
  return result;
}

void free(void *p) {
  (void)p;
}

/* ---- the libc functions the SDK may call -------------------------------- */

void *memcpy(void *dst, const void *src, size_t n) {
  /* -mbulk-memory lowers this to the memory.copy instruction. */
  __builtin_memcpy(dst, src, n);
  return dst;
}

void *memset(void *dst, int value, size_t n) {
  __builtin_memset(dst, value, n);
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  __builtin_memmove(dst, src, n);
  return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
  const uint8_t *x = (const uint8_t *)a;
  const uint8_t *y = (const uint8_t *)b;
  for (size_t i = 0; i < n; i++) {
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/* ---- decode ------------------------------------------------------------- */

static void *sz_alloc(ISzAllocPtr p, size_t size) {
  (void)p;
  return malloc(size);
}

static void sz_free(ISzAllocPtr p, void *address) {
  (void)p;
  free(address);
}

static ISzAlloc g_alloc = { sz_alloc, sz_free };

/*
 * Decode one LZMA1 stream.
 * returns bytes written, or -1 allocate, -2 corrupt, -3 output too small.
 */
int32_t lzma_decode(const uint8_t *props, uint32_t props_len,
                    const uint8_t *in, uint32_t in_len,
                    const uint8_t *out, uint32_t out_cap) {
  CLzmaDec state;
  SizeT src = in_len;
  SizeT dst = out_cap;
  ELzmaStatus status;
  SRes result;

  if (props_len != LZMA_PROPS_SIZE) return -1;
  LzmaDec_Construct(&state);
  if (LzmaDec_Allocate(&state, props, props_len, &g_alloc) != SZ_OK) return -1;
  LzmaDec_Init(&state);
  result = LzmaDec_DecodeToBuf(&state, (Byte *)out, &dst, (Byte *)in, &src, LZMA_FINISH_END, &status);
  LzmaDec_Free(&state, &g_alloc);
  if (result != SZ_OK) return -2;
  return (int32_t)dst;
}

/** Decode one LZMA2 stream; props is the single dictionary-size byte. */
int32_t lzma2_decode(const uint8_t *props, uint32_t props_len,
                     const uint8_t *in, uint32_t in_len,
                     uint8_t *out, uint32_t out_cap) {
  CLzma2Dec state;
  SizeT src = in_len;
  SizeT dst = out_cap;
  ELzmaStatus status;
  SRes result;

  if (props_len != 1) return -1;
  Lzma2Dec_Construct(&state);
  if (Lzma2Dec_Allocate(&state, props[0], &g_alloc) != SZ_OK) return -1;
  Lzma2Dec_Init(&state);
  result = Lzma2Dec_DecodeToBuf(&state, out, &dst, (Byte *)in, &src, LZMA_FINISH_END, &status);
  Lzma2Dec_Free(&state, &g_alloc);
  if (result != SZ_OK) return -2;
  return (int32_t)dst;
}


/** CRC32 (IEEE) of one buffer, for verifying an entry after decode. */
uint32_t crc32_buf(const uint8_t *data, uint32_t length) {
  uint32_t crc = 0xFFFFFFFFu;
  for (uint32_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
  }
  return crc ^ 0xFFFFFFFFu;
}

/* ---- filters ------------------------------------------------------------ */

/**
 * x86 BCJ decode, applied to a whole unpacked stream.
 * @param data - decoded bytes, modified in place
 * @param size - byte count
 * @param pc - virtual address of the first byte
 */
int32_t bcj_x86(uint8_t *data, uint32_t size, uint32_t pc) {
  UInt32 state = Z7_BRANCH_CONV_ST_X86_STATE_INIT_VAL;
  z7_BranchConvSt_X86_Dec((Byte *)data, size, pc, &state);
  return (int32_t)size;
}

/** Delta decode: distance comes from the coder properties (distance - 1). */
int32_t delta_decode(uint8_t *data, uint32_t size, uint32_t distance) {
  Byte state[DELTA_STATE_SIZE];
  Delta_Init(state);
  Delta_Decode(state, (unsigned)distance, (Byte *)data, size);
  return (int32_t)size;
}