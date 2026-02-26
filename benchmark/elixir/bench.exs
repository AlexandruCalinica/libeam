# Elixir GenStage Benchmarks
#
# Equivalent to libeam's benchmark/gen_stage.bench.ts
# Run: cd benchmark/elixir && mix deps.get && mix run bench.exs

Logger.configure(level: :warning)

defmodule Bench do
  @events 10_000
  @events_broadcast 2_000
  @events_sup 200

  # Flush stale :done messages from process mailbox
  defp flush do
    receive do
      {_, :done} -> flush()
    after
      0 -> :ok
    end
  end

  @doc """
  Run a fan-out pipeline: Producer → N Consumers with configurable dispatcher.
  """
  def run_fanout(total, num_consumers, dispatcher_type, opts \\ []) do
    max_demand = Keyword.get(opts, :max_demand, 100)
    min_demand = Keyword.get(opts, :min_demand, div(max_demand * 3, 4))
    demand_mode = Keyword.get(opts, :demand, :forward)

    {dispatcher, expected, is_partition} =
      case dispatcher_type do
        :demand ->
          {GenStage.DemandDispatcher, total, false}

        :broadcast ->
          {GenStage.BroadcastDispatcher, total * num_consumers, false}

        {:partition, n} ->
          {{GenStage.PartitionDispatcher,
            partitions: n, hash: fn event -> {event, rem(event, n)} end}, total, true}
      end

    ref = make_ref()
    counter = :counters.new(1, [:atomics])
    caller = self()

    {:ok, producer} =
      Stages.FiniteProducer.start_link(
        total: total,
        dispatcher: dispatcher,
        demand: demand_mode
      )

    consumers =
      for _ <- 1..num_consumers do
        {:ok, pid} =
          Stages.TrackingConsumer.start_link(
            counter: counter,
            expected: expected,
            notify: caller,
            ref: ref
          )

        pid
      end

    sub_opts = [to: producer, max_demand: max_demand, min_demand: min_demand]

    if is_partition do
      consumers
      |> Enum.with_index()
      |> Enum.each(fn {consumer, i} ->
        GenStage.sync_subscribe(consumer, [{:partition, i} | sub_opts])
      end)
    else
      Enum.each(consumers, fn consumer ->
        GenStage.sync_subscribe(consumer, sub_opts)
      end)
    end

    # Resume demand if accumulate mode (used for BroadcastDispatcher)
    if demand_mode == :accumulate do
      GenStage.demand(producer, :forward)
    end

    receive do
      {^ref, :done} -> :ok
    after
      30_000 -> raise "Timeout waiting for #{expected} events"
    end

    Enum.each(consumers, &GenStage.stop/1)
    GenStage.stop(producer)
    flush()
  end

  @doc """
  Run a multi-hop pipeline: Producer → [PC]* → Consumer.
  num_pcs=0 means direct Producer → Consumer (1 hop).
  """
  def run_pipeline(total, num_pcs, opts \\ []) do
    max_demand = Keyword.get(opts, :max_demand, 100)
    min_demand = Keyword.get(opts, :min_demand, 75)

    ref = make_ref()
    counter = :counters.new(1, [:atomics])
    caller = self()

    {:ok, producer} = Stages.FiniteProducer.start_link(total: total)

    pcs =
      if num_pcs > 0 do
        for _ <- 1..num_pcs do
          {:ok, pid} = Stages.PassthroughPC.start_link()
          pid
        end
      else
        []
      end

    {:ok, consumer} =
      Stages.TrackingConsumer.start_link(
        counter: counter,
        expected: total,
        notify: caller,
        ref: ref
      )

    # Build subscription chain: producer → pc1 → pc2 → ... → consumer
    sub_opts = [max_demand: max_demand, min_demand: min_demand]
    chain = [producer | pcs] ++ [consumer]

    chain
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.each(fn [upstream, downstream] ->
      GenStage.sync_subscribe(downstream, [{:to, upstream} | sub_opts])
    end)

    receive do
      {^ref, :done} -> :ok
    after
      30_000 -> raise "Timeout waiting for #{total} events"
    end

    GenStage.stop(consumer)
    Enum.each(Enum.reverse(pcs), &GenStage.stop/1)
    GenStage.stop(producer)
    flush()
  end

  @doc """
  Run ConsumerSupervisor benchmark: spawns one worker per event.
  """
  def run_consumer_supervisor(total, opts \\ []) do
    max_demand = Keyword.get(opts, :max_demand, 10)
    min_demand = Keyword.get(opts, :min_demand, div(max_demand * 3, 4))

    ref = make_ref()
    counter = :counters.new(1, [:atomics])
    caller = self()

    {:ok, producer} = Stages.FiniteProducer.start_link(total: total)

    {:ok, sup} =
      Stages.BenchConsumerSupervisor.start_link(
        counter: counter,
        expected: total,
        notify: caller,
        ref: ref
      )

    GenStage.sync_subscribe(sup,
      to: producer,
      max_demand: max_demand,
      min_demand: min_demand
    )

    receive do
      {^ref, :done} -> :ok
    after
      30_000 -> raise "Timeout waiting for #{total} workers"
    end

    GenStage.stop(sup)
    GenStage.stop(producer)
    flush()
  end

  def run do
    IO.puts("=" |> String.duplicate(60))
    IO.puts("Elixir GenStage Benchmarks")
    IO.puts("Elixir #{System.version()} on OTP #{System.otp_release()}")
    IO.puts("=" |> String.duplicate(60))
    IO.puts("")

    benchee_opts = [time: 3, warmup: 1, print: [configuration: false]]

    # 1. Baseline: Producer → Consumer
    Benchee.run(
      %{
        "#{@events} events, maxDemand=100" => fn ->
          run_fanout(@events, 1, :demand, max_demand: 100)
        end,
        "#{@events} events, maxDemand=1000" => fn ->
          run_fanout(@events, 1, :demand, max_demand: 1000)
        end
      },
      [{:title, "Baseline: Producer → Consumer"} | benchee_opts]
    )

    # 2. Fan-out: DemandDispatcher
    Benchee.run(
      for n <- [1, 2, 4, 8], into: %{} do
        {"#{@events} events → #{n} consumer(s)", fn -> run_fanout(@events, n, :demand) end}
      end,
      [{:title, "Fan-out: DemandDispatcher"} | benchee_opts]
    )

    # 3. Fan-out: BroadcastDispatcher
    # Use accumulate mode to ensure all consumers subscribe before events flow
    Benchee.run(
      for n <- [1, 2, 4, 8], into: %{} do
        {"#{@events_broadcast} events → #{n} consumer(s)",
         fn -> run_fanout(@events_broadcast, n, :broadcast, demand: :accumulate) end}
      end,
      [{:title, "Fan-out: BroadcastDispatcher"} | benchee_opts]
    )

    # 4. Routing: PartitionDispatcher
    Benchee.run(
      for n <- [2, 4, 8], into: %{} do
        {"#{@events} events → #{n} partitions", fn -> run_fanout(@events, n, {:partition, n}) end}
      end,
      [{:title, "Routing: PartitionDispatcher"} | benchee_opts]
    )

    # 5. Pipeline depth
    Benchee.run(
      %{
        "#{@events} events: P → C (1 hop)" => fn ->
          run_pipeline(@events, 0)
        end,
        "#{@events} events: P → PC → C (2 hops)" => fn ->
          run_pipeline(@events, 1)
        end,
        "#{@events} events: P → PC → PC → C (3 hops)" => fn ->
          run_pipeline(@events, 2)
        end
      },
      [{:title, "Pipeline depth"} | benchee_opts]
    )

    # 6. ConsumerSupervisor
    Benchee.run(
      for max_d <- [5, 10, 20], into: %{} do
        {"#{@events_sup} events, maxDemand=#{max_d} (spawn+exit per event)",
         fn -> run_consumer_supervisor(@events_sup, max_demand: max_d) end}
      end,
      [{:title, "ConsumerSupervisor"} | benchee_opts]
    )

    # 7. Dispatcher comparison (4 consumers, same workload as libeam benchmarks)
    Benchee.run(
      %{
        "DemandDispatcher" => fn ->
          run_fanout(@events, 4, :demand)
        end,
        "BroadcastDispatcher" => fn ->
          run_fanout(@events_broadcast, 4, :broadcast, demand: :accumulate)
        end,
        "PartitionDispatcher" => fn ->
          run_fanout(@events, 4, {:partition, 4})
        end
      },
      [{:title, "Dispatcher comparison: 4 consumers"} | benchee_opts]
    )
  end
end

Bench.run()
