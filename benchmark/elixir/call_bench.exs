Logger.configure(level: :warning)

defmodule CallBench do
  @calls 10_000
  @calls_contention 5_000

  def run_sequential(calls) do
    {:ok, pid} = Stages.Counter.start_link()

    for _ <- 1..calls do
      GenServer.call(pid, :increment)
    end

    GenServer.stop(pid)
  end

  def run_sequential_echo(calls) do
    {:ok, pid} = Stages.Echo.start_link()

    for i <- 1..calls do
      ^i = GenServer.call(pid, i)
    end

    GenServer.stop(pid)
  end

  def run_parallel(calls, num_actors) do
    actors =
      for _ <- 1..num_actors do
        {:ok, pid} = Stages.Echo.start_link()
        pid
      end

    calls_per_actor = div(calls, num_actors)

    for _ <- 1..calls_per_actor do
      actors
      |> Enum.map(fn pid -> Task.async(fn -> GenServer.call(pid, :ping) end) end)
      |> Task.await_many()
    end

    Enum.each(actors, &GenServer.stop/1)
  end

  def run_contention(total_calls, in_flight) do
    {:ok, pid} = Stages.Echo.start_link()

    Stream.chunk_every(1..total_calls, in_flight)
    |> Enum.each(fn batch ->
      batch
      |> Enum.map(fn i -> Task.async(fn -> GenServer.call(pid, i) end) end)
      |> Task.await_many()
    end)

    GenServer.stop(pid)
  end

  def run_chain(calls, depth) do
    {:ok, echo} = Stages.Echo.start_link()

    target =
      Enum.reduce(1..depth, echo, fn _, prev ->
        {:ok, fwd} = Stages.Forwarder.start_link(prev)
        fwd
      end)

    for i <- 1..calls do
      ^i = GenServer.call(target, i)
    end

    GenServer.stop(target)
    if depth > 0, do: GenServer.stop(echo)
  end

  def run_mixed(calls) do
    {:ok, pid} = Stages.Counter.start_link()

    for i <- 1..calls do
      if rem(i, 2) == 0 do
        GenServer.call(pid, :increment)
      else
        GenServer.cast(pid, :increment)
      end
    end

    GenServer.call(pid, :get)
    GenServer.stop(pid)
  end

  def run do
    IO.puts(String.duplicate("=", 60))
    IO.puts("Elixir Call Benchmarks")
    IO.puts("Elixir #{System.version()} on OTP #{System.otp_release()}")
    IO.puts(String.duplicate("=", 60))
    IO.puts("")

    benchee_opts = [time: 3, warmup: 1, print: [configuration: false]]

    Benchee.run(
      %{
        "#{@calls} sequential calls" => fn -> run_sequential(@calls) end,
        "#{@calls} sequential echo calls" => fn -> run_sequential_echo(@calls) end
      },
      [{:title, "Sequential calls: 1 caller → 1 actor"} | benchee_opts]
    )

    Benchee.run(
      for n <- [1, 4, 8, 16], into: %{} do
        {"#{@calls} calls → #{n} actor(s)", fn -> run_parallel(@calls, n) end}
      end,
      [{:title, "Parallel calls: fan-out to N actors"} | benchee_opts]
    )

    Benchee.run(
      for n <- [10, 50, 100], into: %{} do
        {"#{@calls_contention} calls, #{n} in-flight",
         fn -> run_contention(@calls_contention, n) end}
      end,
      [{:title, "Contention: N callers → 1 actor"} | benchee_opts]
    )

    Benchee.run(
      %{
        "#{@calls} calls: A → B (1 hop)" => fn -> run_chain(@calls, 1) end,
        "#{@calls} calls: A → B → C (2 hops)" => fn -> run_chain(@calls, 2) end
      },
      [{:title, "Call chain depth"} | benchee_opts]
    )

    Benchee.run(
      %{
        "#{@calls} ops (50/50 call/cast)" => fn -> run_mixed(@calls) end
      },
      [{:title, "Mixed: calls + casts interleaved"} | benchee_opts]
    )
  end
end

CallBench.run()
