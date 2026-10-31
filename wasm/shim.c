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


/* ---- errno -------------------------------------------------------------- */

static int g_errno = 0;

int *__errno_location(void) {
  return &g_errno;
}

/* ---- allocator ---------------------------------------------------------- */

#define ARENA_BYTES (96u * 1024u * 1024u)
static uint8_t g_arena[ARENA_BYTES] __attribute__((aligned(16)));
static uint32_t g_used = 0;

void reset_heap(void) {
  g_used = 0;
}

void *malloc(size_t size) {
  uint32_t aligned = (uint32_t)((size + 15u) & ~(size_t)15u);
  if (g_used + aligned > ARENA_BYTES) return 0;
  void *result = &g_arena[g_used];
  g_used += aligned;
  return result;
}

void free(void *p) {
  (void)p;
}

/* ---- the libc functions the SDK may call -------------------------------- */

void *memcpy(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst;
  const uint8_t *s = (const uint8_t *)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

void *memset(void *dst, int value, size_t n) {
  uint8_t *d = (uint8_t *)dst;
  for (size_t i = 0; i < n; i++) d[i] = (uint8_t)value;
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst;
  const uint8_t *s = (const uint8_t *)src;
  if (d < s) {
    for (size_t i = 0; i < n; i++) d[i] = s[i];
  } else {
    for (size_t i = n; i > 0; i--) d[i - 1] = s[i - 1];
  }
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
