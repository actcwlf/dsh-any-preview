/* Minimal libc surface for the freestanding build (-nostdlib). */
#ifndef DSH_MINIMAL_STDLIB_H
#define DSH_MINIMAL_STDLIB_H
#include <stddef.h>

void *malloc(size_t size);
void free(void *p);
void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int value, size_t n);
void *memmove(void *dst, const void *src, size_t n);

#endif
