using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using NasDeck.Agent;
using NasDeck.Protocol;

// --port N     the loopback port to serve on (default 16000)
// --data PATH  where the token and state live (default ..\data beside the executable's folder)
var port = AgentApi.DefaultPort;
var dataDirectory = Path.Combine(AppContext.BaseDirectory, "..", "data");
for (var index = 0; index + 1 < args.Length; index += 2)
{
    if (args[index] == "--port" && int.TryParse(args[index + 1], out var parsed) && parsed is > 0 and < 65536) port = parsed;
    else if (args[index] == "--data") dataDirectory = args[index + 1];
    else throw new ArgumentException($"Unknown or invalid option: {args[index]} {args[index + 1]}");
}
dataDirectory = Path.GetFullPath(dataDirectory);
Directory.CreateDirectory(dataDirectory);

// The token is what stops other local programs, and web pages aimed at localhost, from driving the disks.
var tokenPath = Path.Combine(dataDirectory, "token");
if (!File.Exists(tokenPath)) File.WriteAllText(tokenPath, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
var token = Encoding.UTF8.GetBytes(File.ReadAllText(tokenPath).Trim());

var builder = WebApplication.CreateBuilder();
builder.Host.UseWindowsService(options => options.ServiceName = "NasDeckAgent");
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.WebHost.ConfigureKestrel(kestrel => kestrel.Listen(IPAddress.Loopback, port));
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(services => new Sampler(dataDirectory, services.GetRequiredService<ILogger<Sampler>>()));
builder.Services.AddHostedService(services => services.GetRequiredService<Sampler>());

var app = builder.Build();
app.Use(async (context, next) =>
{
    var supplied = Encoding.UTF8.GetBytes(context.Request.Headers[AgentApi.TokenHeader].ToString());
    if (!CryptographicOperations.FixedTimeEquals(supplied, token))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }
    await next();
});

app.MapGet("/api/snapshot", (Sampler sampler) =>
    sampler.Current is { } snapshot ? Results.Json(snapshot) : Results.StatusCode(StatusCodes.Status503ServiceUnavailable));
app.MapGet("/api/disks/{number:int}", (int number, Sampler sampler) =>
    sampler.Detail(number) is { } detail ? Results.Json(detail) : Results.NotFound());
app.MapPost("/api/disks/sleep", (Sampler sampler) => sampler.SleepAll());
app.MapPost("/api/disks/{number:int}/sleep", (int number, bool? force, Sampler sampler) => sampler.Sleep(number, force == true));
app.MapPost("/api/disks/{number:int}/wake", (int number, Sampler sampler) => sampler.Wake(number));
app.MapPut("/api/policy", (PowerPolicy policy, Sampler sampler) => sampler.SetPolicy(policy));

app.Run();
