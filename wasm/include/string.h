/* Minimal libc surface for the freestanding build (-nostdlib). */
#ifndef DSH_MINIMAL_STRING_H
#define DSH_MINIMAL_STRING_H
#include <stddef.h>

void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int value, size_t n);
void *memmove(void *dst, const void *src, size_t n);
int memcmp(const void *a, const void *b, size_t n);

#endif
