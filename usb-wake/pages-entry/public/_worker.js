export default {
  fetch(request, env) {
    return env.RELAY.fetch(request);
  },
};
