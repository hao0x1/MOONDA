// Darwin's physical footprint includes compressed pages, unlike RSS. Query each Chrome
// process separately so the harness can compare the whole browser after the same workload.
// Compile with: xcrun clang -O2 scripts/check-layer-memory.c -o <SSD scratch>/check-layer-memory
// Then pass that binary to check-layer-speed.mjs with --memory-helper <absolute path>.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  putchar('{');
  for (int i = 1; i < argc; ++i) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(argv[i], &end, 10);
    if (errno || !end || *end || parsed <= 0 || parsed > INT_MAX) {
      fprintf(stderr, "Invalid PID: %s\n", argv[i]);
      return 2;
    }
    if (i > 1) putchar(',');
    printf("\"%ld\":", parsed);
    struct rusage_info_v4 info = {0};
    if (proc_pid_rusage((int)parsed, RUSAGE_INFO_V4, (rusage_info_t *)&info) == 0)
      printf("%" PRIu64, info.ri_phys_footprint);
    else
      // A Chrome process can finish between the process-list snapshot and this query.
      fputs("null", stdout);
  }
  puts("}");
  return 0;
}
