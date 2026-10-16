FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3-setuptools git ca-certificates && rm -r /var/lib/apt/lists/*
RUN npm install --global pnpm@11.28.5
WORKDIR /opt/dsh
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
COPY . /opt/dsh
RUN pnpm install --frozen-lockfile
RUN pnpm run build:native-system && pnpm run build:lib:host
RUN mkdir -p /var/lib/trajectory /home/node/.dsh && chown 1000:1000 /var/lib/trajectory /home/node/.dsh
USER 1000:1000
ENV DSH_HOME=/home/node/.dsh
ENTRYPOINT ["sh", "-ec", "case \"${COURSE_COLLECTOR_PROFILE:-course-trajectories}\" in course-trajectories|course-trajectories-local) ;; *) exit 64 ;; esac; mkdir -p \"$DSH_HOME/profiles\"; cp -R /opt/dsh/course/trajectory-collector/profile \"$DSH_HOME/profiles/course-trajectories\"; cp -R /opt/dsh/course/trajectory-collector/profile-local \"$DSH_HOME/profiles/course-trajectories-local\"; exec node /opt/dsh/apps/cli/lib/bin.js --profile \"${COURSE_COLLECTOR_PROFILE:-course-trajectories}\" \"$@\"", "course-collector"]
