/* A credential-consuming CLI fixture: reads the same -pc file as PD tools, sends no traffic. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/stat.h>
int main(int argc, char **argv) {
  const char *path = NULL; int fail = 0, pause_run = 0;
  for (int i = 1; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "-pc")) path = argv[i + 1];
    if (!strcmp(argv[i], "-s") && !strcmp(argv[i + 1], "failure")) fail = 1;
    if (!strcmp(argv[i], "-s") && !strcmp(argv[i + 1], "pause")) pause_run = 1;
  }
  if (!path) {
    const char *key = getenv("PDCP_API_KEY"); if (!key) return 3;
    for (int i = 1; i < argc; i++) if (strstr(argv[i], key)) return 7;
    fprintf(stderr, "%s", key);
    printf("{\"pdcpApiKey\":\"%s\"}\n", key); return 0;
  }
  FILE *file = fopen(path, "r"); if (!file) return 4;
  char data[32768]; size_t size = fread(data, 1, sizeof(data) - 1, file); data[size] = 0;
  struct stat info; if (fstat(fileno(file), &info)) return 5; fclose(file);
  if (pause_run) sleep(5);
  fprintf(stderr, "%s", data);
  printf("{\"fileMode\":%u,\"providers\":%s}\n", (unsigned)(info.st_mode & 0777), data);
  return fail ? 6 : 0;
}
