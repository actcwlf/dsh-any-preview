/* Minimal errno for the freestanding build: one process-wide slot. */
#ifndef DSH_MINIMAL_ERRNO_H
#define DSH_MINIMAL_ERRNO_H

int *__errno_location(void);
#define errno (*__errno_location())

#define EINVAL 22
#define ENOMEM 12
#define EIO 5

#endif
